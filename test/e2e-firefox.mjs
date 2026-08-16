/*
 * The Firefox half of the end-to-end check.
 *
 * Both browsers load byte-identical `src/`, so this is not re-testing the
 * rewriting logic — it is testing the two things that are genuinely
 * Firefox-specific and would otherwise rest on documentation alone:
 *
 *   1. Firefox honours `world: "MAIN"` in an MV3 content script (128+), and
 *   2. it runs that script early enough to beat Bluesky's
 *      `let P = globalThis.fetch` snapshot.
 *
 * Requires geckodriver and a Firefox binary; point at them explicitly if they
 * are not on PATH:
 *
 *   GECKODRIVER=/path/to/geckodriver FIREFOX_BIN=/path/to/firefox \
 *     node scripts/build.mjs firefox && node test/e2e-firefox.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { SCENARIOS } from './scenarios.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const XPI = path.join(ROOT, 'dist', `bsky-not-blocked-firefox-${version}.zip`);

if (!fs.existsSync(XPI)) throw new Error('run `node scripts/build.mjs firefox` first');
if (process.env.GECKODRIVER) {
  process.env.PATH = `${path.dirname(process.env.GECKODRIVER)}${path.delimiter}${process.env.PATH}`;
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const options = new firefox.Options().addArguments('-headless');
// Toggling deep recovery asks for the `browsingActivity` data permission, which
// normally raises a doorhanger no WebDriver session can answer. This pref grants
// optional permissions without prompting, so the run exercises the code path
// rather than hanging on chrome UI it cannot reach.
options.setPreference('extensions.webextOptionalPermissionPrompts', false);
if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);

const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();

try {
  // `true` installs it as a temporary add-on, which is what an unsigned MV3
  // build needs — the same path as about:debugging.
  await driver.installAddon(XPI, true);
  check('temporary add-on installed', true);

  for (const scenario of SCENARIOS) {
    console.log(`\n# ${scenario.name}`);
    await driver.get(scenario.url);

    await driver.wait(async () => driver.executeScript(() => Boolean(window.__bskyNotBlocked)), 30_000);
    check('interceptor is installed in the page world', true);

    await driver.wait(async () => {
      const stats = await driver.executeScript(() => window.__bskyNotBlocked?.stats ?? null);
      return stats && stats.restoredQuotes + stats.restoredPosts > 0;
    }, 40_000);
    const stats = await driver.executeScript(() => ({ ...window.__bskyNotBlocked.stats }));
    check('interceptor patched fetch before the app captured it', true, JSON.stringify(stats));

    const body = await driver.findElement(By.css('body'));
    for (const needle of scenario.expect) {
      const rendered = await driver
        .wait(until.elementTextContains(body, needle), 40_000)
        .then(() => true, () => false);
      check(`renders "${needle}"`, rendered);
    }
    if (scenario.absent) {
      const text = await body.getText();
      check(`no "${scenario.absent}" placeholder remains`, !text.includes(scenario.absent));
    }
  }
} finally {
  await driver.quit();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
