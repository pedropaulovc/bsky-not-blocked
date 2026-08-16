/*
 * Produces the listing screenshots the three stores ask for.
 *
 * This is deliberately separate from test/e2e.mjs. That suite proves behaviour
 * and screenshots whatever window it happens to get; the stores reject anything
 * that is not exactly one of their accepted sizes, so the asset pipeline pins
 * the viewport and does nothing else.
 *
 * Each scenario is shot twice: once with the extension loaded and once without,
 * so the listing can show the grey "Blocked" placeholder next to the restored
 * post. That before/after pair is the only honest way to describe what this
 * does — a single screenshot of a working thread looks like plain Bluesky.
 *
 *   npm run build && node scripts/store-screenshots.mjs
 *
 * Writes to store/screenshots/. Requires a display; under CI use xvfb-run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SCENARIOS } from '../test/scenarios.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = path.join(ROOT, 'dist', 'chrome');
const OUT = path.join(ROOT, 'store', 'screenshots');

// Chrome Web Store accepts 1280x800 or 640x400. Edge's Partner Center asks for
// 1366x768. AMO has no fixed size, so it reuses the Chrome set.
const SIZES = [
  { name: 'chrome', width: 1280, height: 800 },
  { name: 'edge', width: 1366, height: 768 },
];

if (!fs.existsSync(EXTENSION)) throw new Error('run `npm run build` first');
fs.mkdirSync(OUT, { recursive: true });

async function shoot({ width, height }, { url, expect }, { withExtension, file }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bsky-shots-'));
  const args = ['--no-sandbox', `--window-size=${width},${height}`];
  if (withExtension) {
    args.push(`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`);
  }

  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width, height },
    args,
  });

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Wait for the thing the shot is meant to show, rather than a fixed delay:
    // with the extension, the restored text; without it, the placeholder. Either
    // way the page is past its skeleton loaders by the time it is captured.
    const needle = withExtension ? expect[0] : 'Blocked';
    await page
      .waitForFunction((text) => document.body.innerText.includes(text), needle, { timeout: 30_000 })
      .catch(() => console.warn(`  ! "${needle}" never appeared — check the scenario is still live`));

    // Bluesky anchors the scroll on the focused post, which can leave the
    // interesting part just above the fold.
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, -3000);
    await page.waitForTimeout(1500);

    await page.screenshot({ path: file });
    console.log(`  ${path.relative(ROOT, file)}`);
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

for (const size of SIZES) {
  console.log(`\n# ${size.name} (${size.width}x${size.height})`);
  for (const [index, scenario] of SCENARIOS.entries()) {
    const slug = scenario.name.replace(/\W+/g, '-');
    for (const withExtension of [false, true]) {
      const state = withExtension ? 'after' : 'before';
      await shoot(size, scenario, {
        withExtension,
        file: path.join(OUT, `${size.name}-${index + 1}-${slug}-${state}.png`),
      });
    }
  }
}

console.log(`\nWrote ${fs.readdirSync(OUT).length} files to ${path.relative(ROOT, OUT)}`);
