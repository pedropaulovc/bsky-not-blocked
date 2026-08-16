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
const POST = 'https://bsky.app/profile/ed3d.net/post/3mt5jmqs4n22n';
// The post hidden behind the "Blocked" card on that thread.
const HIDDEN_HANDLE = '@skity.bsky.social';
const HIDDEN_TEXT = 'Coding is largely solved';

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
  const page = await context.newPage();
  await page.goto(POST, { waitUntil: 'domcontentloaded' });

  // 1. The content script reached the page world at all.
  await page.waitForFunction(() => Boolean(window.__bskyNotBlocked), null, { timeout: 20_000 });
  check('interceptor is installed in the page world', true);

  // 2. It won the race against the app's `let P = globalThis.fetch` snapshot.
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

  // 3. Bluesky rendered the restored post natively.
  const body = await page.locator('body').innerText();
  check('the hidden post\'s author is rendered', body.includes(HIDDEN_HANDLE), HIDDEN_HANDLE);
  check('the hidden post\'s text is rendered', body.includes(HIDDEN_TEXT), `"${HIDDEN_TEXT}"`);
  check('no "Blocked" placeholder remains on the focused post', !body.includes('Blocked'));

  const shot = path.join(ROOT, 'dist', 'e2e-restored.png');
  await page.screenshot({ path: shot, fullPage: false });
  console.log(`\nscreenshot: ${path.relative(ROOT, shot)}`);
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
