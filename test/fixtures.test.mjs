/*
 * The fixtures are recordings of real Bluesky traffic, anonymized before they
 * are written. That property is easy to lose: the recorder walks the payload
 * key by key, so a field Bluesky adds later — or one nobody thought about —
 * passes through untouched. It has happened already, with a profile's
 * `messageMeUrl` and `pronouns`.
 *
 * These tests are the backstop. They assert the shape of the *anonymized*
 * output rather than trusting the recorder to have covered every field, so a
 * leak fails the suite instead of reaching a commit.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const files = fs.readdirSync(FIXTURES).filter((name) => name.endsWith('.json'));

const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** Synthetic shapes the recorder produces, mirrored here deliberately. */
const SYNTHETIC_DID = /^did:plc:a{20}\d{4}$/;
const SYNTHETIC_HANDLE = /^user\d{4}\.example$/;
const ALLOWED_URL = /^https:\/\/(cdn\.bsky\.app\/img\/|example\.com\/link\/)/;

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    visit(key, value);
    walk(value, visit);
  }
};

test('every fixture is present and parses', () => {
  assert.ok(files.length >= 6, `expected the recorded corpus, found ${files.length} files`);
  for (const name of files) assert.doesNotThrow(() => JSON.parse(read(name)), name);
});

test('no fixture contains a real DID', () => {
  for (const name of files) {
    for (const did of read(name).match(/did:plc:[a-z0-9]+/g) ?? []) {
      assert.match(did, SYNTHETIC_DID, `${name} leaks a live DID`);
    }
    // did:web embeds the account's own domain, so it leaks even more directly.
    for (const did of read(name).match(/did:web:[a-zA-Z0-9.:%-]+/g) ?? []) {
      assert.match(did, /^did:web:host\d{4}\.example$/, `${name} leaks a live did:web domain`);
    }
  }
});

test('no fixture carries a real timestamp', () => {
  // An account's createdAt is millisecond-precision and public, so on its own it
  // maps an anonymized author back to the real account.
  for (const name of files) {
    for (const stamp of read(name).match(/"\d{4}-\d{2}-\d{2}T[\d:.]+Z"/g) ?? []) {
      assert.match(stamp, /^"2020-01-\d{2}T\d{2}:\d{2}:00\.000Z"$/, `${name} leaks a live timestamp`);
    }
  }
});

test('no fixture contains a real handle', () => {
  for (const name of files) {
    walk(JSON.parse(read(name)), (key, value) => {
      if (key === 'handle') assert.match(value, SYNTHETIC_HANDLE, `${name} leaks a live handle`);
    });
  }
});

test('no fixture links anywhere but the Bluesky CDN', () => {
  // The case that got through the first time: a profile's messageMeUrl pointing
  // at a real person's landing page.
  for (const name of files) {
    for (const url of read(name).match(/https?:\\?\/\\?\/[^"\\]+/g) ?? []) {
      assert.match(url.replace(/\\/g, ''), ALLOWED_URL, `${name} leaks an external URL`);
    }
  }
});

test('no fixture carries free text that was not replaced', () => {
  // Anything a person typed is rewritten to one of these forms, so a value that
  // matches neither is a field the recorder walked straight past.
  const SYNTHETIC_TEXT = /^(Sample post text|Test User) \d{4}$/;
  const STRUCTURAL = new Set([
    '$type', '$link', 'uri', 'cid', 'did', 'src', 'val', 'via', 'mimeType',
    'createdAt', 'indexedAt', 'cts', 'expiresAt', 'lang', 'langs',
    'allowIncoming', 'allowSubscriptions', 'allowGroupInvites', 'showButtonTo',
    'handle', 'avatar', 'thumb', 'fullsize', 'messageMeUrl',
  ]);

  for (const name of files) {
    walk(JSON.parse(read(name)), (key, value) => {
      if (typeof value !== 'string' || !value) return;
      if (STRUCTURAL.has(key) || ALLOWED_URL.test(value)) return;
      assert.match(value, SYNTHETIC_TEXT, `${name}: "${key}" was not anonymized`);
    });
  }
});
