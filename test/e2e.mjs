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
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SCENARIOS } from './scenarios.mjs';

/**
 * Chrome derives an unpacked extension's ID from the absolute path of its
 * directory: the first 16 bytes of the SHA-256, with each hex digit remapped
 * from 0-f to a-p. Deriving it beats scraping chrome://extensions, and this
 * build has no service worker whose URL would otherwise reveal it.
 */
function unpackedExtensionId(dir) {
  const digest = crypto.createHash('sha256').update(dir, 'utf8').digest('hex').slice(0, 32);
  return [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('');
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = path.join(ROOT, 'dist', 'chrome');

const POPUP = `chrome-extension://${unpackedExtensionId(EXTENSION)}/src/popup.html`;

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

  // The popup is the only UI the extension owns; check it loads and that a
  // toggle actually reaches storage rather than silently doing nothing.
  console.log('\n# popup');
  const popup = await context.newPage();
  await popup.goto(POPUP);
  check('popup page loads', await popup.locator('#enabled').isVisible());

  const before = await popup.evaluate(() => chrome.storage.local.get({ deepRecovery: false }));
  await popup.locator('#deepRecovery').click();
  const after = await popup.evaluate(() => chrome.storage.local.get({ deepRecovery: false }));
  check('toggling a setting persists it', before.deepRecovery === false && after.deepRecovery === true);
  await popup.close();

  // Deep recovery is now on, so the opt-in path can be exercised for real. This
  // thread is the hard case: the reply is not stubbed, it is absent from the
  // response entirely, and only the backlink index can name it.
  console.log('\n# hidden reply (deep recovery)');
  const deep = await context.newPage();
  await deep.goto('https://bsky.app/profile/aly.codes/post/3mt5l6lu5ec22', { waitUntil: 'domcontentloaded' });
  const recovered = await deep
    .waitForFunction(() => document.body.innerText.includes('act as scabs'), null, { timeout: 45_000 })
    .then(() => true, () => false);
  check('a reply the AppView dropped entirely is restored', recovered);
  const deepStats = await deep.evaluate(() => ({ ...window.__bskyNotBlocked.stats }));
  check('it came through the recovery path', deepStats.recoveredReplies > 0, JSON.stringify(deepStats));
  await deep.screenshot({ path: path.join(ROOT, 'dist', 'e2e-hidden-reply.png') });
  await deep.close();
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
