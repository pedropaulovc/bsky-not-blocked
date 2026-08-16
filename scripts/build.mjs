/*
 * Assembles dist/chrome and dist/firefox from the shared src/ tree plus the
 * per-browser manifest, then zips each for upload. There is no bundler and no
 * transpile step — what ships is what is in src/.
 *
 *   node scripts/build.mjs           # build both
 *   node scripts/build.mjs chrome    # build one
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const SHARED = ['src', 'icons'];
const TARGETS = ['chrome', 'firefox'];

const wanted = process.argv.slice(2);
const targets = wanted.length ? wanted : TARGETS;

for (const target of targets) {
  if (!TARGETS.includes(target)) throw new Error(`unknown target: ${target}`);

  const out = path.join(DIST, target);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  for (const dir of SHARED) {
    fs.cpSync(path.join(ROOT, dir), path.join(out, dir), { recursive: true });
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifests', `${target}.json`), 'utf8'));
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  manifest.version = version;
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const zip = path.join(DIST, `bsky-not-blocked-${target}-${version}.zip`);
  fs.rmSync(zip, { force: true });
  try {
    execFileSync('zip', ['-qr', zip, '.'], { cwd: out });
    console.log(`${target}: ${path.relative(ROOT, out)} and ${path.relative(ROOT, zip)}`);
  } catch {
    console.log(`${target}: ${path.relative(ROOT, out)} (install \`zip\` to also produce an archive)`);
  }
}
