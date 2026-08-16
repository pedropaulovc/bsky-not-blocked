/*
 * End-to-end check of the packaged extension against live bsky.app.
 *
 * This exists because of a specific failure mode. Bluesky's bundle snapshots
 * `globalThis.fetch` into a module constant the moment it evaluates:
 *
 *     let P = globalThis.fetch
 *
 * so anything that patches fetch *after* the app loads is ignored — the app
 * keeps the original reference. The extension only works because a
 * `world: "MAIN"` content script at `run_at: "document_start"` runs before the
 * bundle. That ordering is the load-bearing assumption of the whole design, and
 * it is invisible to the unit tests, so it gets a real browser.
 *
 * Requires Playwright and a display:
 *   npm i -D playwright && npx playwright install chromium
 *   node scripts/build.mjs && node test/e2e.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = path.join(ROOT, 'dist', 'chrome');

/*
 * Two scenarios, because the two stub kinds are spliced into different shapes
 * and only a real browser proves Bluesky renders each of them.
 */
const SCENARIOS = [
  {
    name: 'blocked quote embed',
    url: 'https://bsky.app/profile/ed3d.net/post/3mt5jmqs4n22n',
    // ed3d.net quotes skity.bsky.social; the two accounts block each other.
    expect: ['@skity.bsky.social', 'Coding is largely solved'],
    // The grey placeholder that stands in for the quote when it is hidden.
    absent: 'Blocked',
  },
  {
    name: 'blocked parent in a thread',
    url: 'https://bsky.app/profile/skity.bsky.social/post/3mt5n422h422o',
    // The parent is by aly.codes, who skity blocks, so it is dropped for everyone.
    expect: ['@aly.codes', 'extremely normal analogy'],
  },
];

if (!fs.existsSync(EXTENSION)) throw new Error('run `node scripts/build.mjs` first');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bsky-not-blocked-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, '--no-sandbox'],
});

try {
  for (const scenario of SCENARIOS) {
    console.log(`\n# ${scenario.name}`);
    const page = await context.newPage();
    await page.goto(scenario.url, { waitUntil: 'domcontentloaded' });

    // 1. The content script reached the page world at all.
    await page.waitForFunction(() => Boolean(window.__bskyNotBlocked), null, { timeout: 20_000 });
    check('interceptor is installed in the page world', true);

    // 2. It won the race against the app's `let P = globalThis.fetch` snapshot.
    // If it lost, the app would be using the original fetch and nothing is restored.
    await page.waitForFunction(
      () => {
        const s = window.__bskyNotBlocked?.stats;
        return s && s.restoredQuotes + s.restoredPosts > 0;
      },
      null,
      { timeout: 30_000 },
    );
    const stats = await page.evaluate(() => ({ ...window.__bskyNotBlocked.stats }));
    check('interceptor patched fetch before the app captured it', true, JSON.stringify(stats));

    // 3. Bluesky rendered the restored post natively. Rewriting the response and
    // painting it are separate events, so this waits rather than reads once.
    for (const needle of scenario.expect) {
      const rendered = await page
        .waitForFunction((text) => document.body.innerText.includes(text), needle, { timeout: 30_000 })
        .then(() => true, () => false);
      check(`renders "${needle}"`, rendered);
    }
    if (scenario.absent) {
      const body = await page.locator('body').innerText();
      check(`no "${scenario.absent}" placeholder remains`, !body.includes(scenario.absent));
    }

    // Bluesky anchors the scroll on the focused post, which can leave a restored
    // parent just above the viewport; scroll up so the screenshot shows it.
    await page.mouse.move(520, 400);
    await page.mouse.wheel(0, -3000);
    await page.waitForTimeout(500);

    const shot = path.join(ROOT, 'dist', `e2e-${scenario.name.replace(/\W+/g, '-')}.png`);
    await page.screenshot({ path: shot });
    console.log(`screenshot: ${path.relative(ROOT, shot)}`);
    await page.close();
  }
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
