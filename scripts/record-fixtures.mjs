/*
 * Regenerates every test fixture:
 *
 *   node scripts/record-fixtures.mjs
 *
 * Three stages.
 *
 * 1. Capture the payloads from the live AppView, from the threads named in
 *    SOURCES. Handles are resolved at capture time so no real DID is written
 *    down here.
 * 2. Replay each payload through the real `src/interceptor.js` with deep
 *    recovery on, against a network that proxies to the live services, and keep
 *    whatever the interceptor asks for. The fixtures are therefore by
 *    construction what the shipping code needs, and there is no second copy of
 *    the scanning rules to drift out of step with it.
 * 3. Anonymize everything before it touches disk. The payloads are real traffic
 *    from real accounts, and a committed fixture outlives the deletion of the
 *    post it came from, so nothing identifiable gets stored. The rewriting is
 *    deterministic and structure-preserving: DIDs, handles, rkeys, CIDs and
 *    text are replaced consistently across all files, so every AT-URI still
 *    resolves within the corpus and the interceptor sees the same shapes.
 *
 * The live and end-to-end tests deliberately keep using the real URLs — they
 * fetch them at run time, so they honour a deletion the way a stored copy
 * cannot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInterceptor } from '../test/harness.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const APPVIEW = 'https://public.api.bsky.app/xrpc';

const V2 = 'app.bsky.unspecced.getPostThreadV2';
const V1 = 'app.bsky.feed.getPostThread';
const FEED = 'app.bsky.feed.getAuthorFeed';

/** Which live threads to capture, and the method whose response each stands in for. */
const SOURCES = [
  // A post whose quote is hidden by a block between the two authors.
  { file: 'thread-v2-blocked-quote.json', method: V2, actor: 'ed3d.net', rkey: '3mt5jmqs4n22n', query: 'below=6' },
  { file: 'thread-v1-blocked-quote.json', method: V1, actor: 'ed3d.net', rkey: '3mt5jmqs4n22n', query: 'depth=6' },
  // A reply whose parent is hidden the same way — the stubbed-ancestor case.
  { file: 'thread-v2-blocked-reply.json', method: V2, actor: 'skity.bsky.social', rkey: '3mt5n422h422o', query: 'below=10&above=true' },
  { file: 'thread-v1-blocked-parent.json', method: V1, actor: 'skity.bsky.social', rkey: '3mt5n422h422o', query: 'depth=4&parentHeight=6' },
  // The other side of that block: the reply is dropped outright, not stubbed.
  { file: 'thread-v2-hidden-reply.json', method: V2, actor: 'aly.codes', rkey: '3mt5l6lu5ec22', query: 'below=6&above=true' },
  // A feed, where a blocked reply parent needs a bare postView rather than a wrapper.
  { file: 'feed-blocked-parent.json', method: FEED, actor: 'skity.bsky.social' },
];

const getJson = (url) => fetch(url, { signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
const write = (name, data) => {
  assertClean(name, data);
  fs.writeFileSync(path.join(FIXTURES, name), `${JSON.stringify(data, null, 2)}\n`);
};

// ------------------------------------------------------------ 1. capture

async function resolveDid(actor) {
  const data = await getJson(`${APPVIEW}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`);
  if (!data.did) throw new Error(`could not resolve ${actor}: ${JSON.stringify(data).slice(0, 200)}`);
  return data.did;
}

async function capture(source) {
  const did = await resolveDid(source.actor);

  if (source.method === FEED) {
    const feed = await getJson(`${APPVIEW}/${FEED}?actor=${did}&limit=100&filter=posts_with_replies`);
    // Keep only the entries that carry a blocked stub, so the fixture stays small.
    const entries = (feed.feed ?? []).filter((e) => JSON.stringify(e).includes('#blockedPost'));
    if (!entries.length) throw new Error(`no blocked stubs in ${source.actor}'s feed`);
    return { feed: entries };
  }

  const uri = `at://${did}/app.bsky.feed.post/${source.rkey}`;
  const param = source.method === V2 ? 'anchor' : 'uri';
  return getJson(`${APPVIEW}/${source.method}?${param}=${encodeURIComponent(uri)}&${source.query}`);
}

// -------------------------------------------------------------- 2. replay

const posts = {};
const constellation = {};

/** Serves the payload under test locally; everything else hits the real service and is kept. */
function recordingNetwork(method, payload) {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);

    if (url.pathname.endsWith(`/xrpc/${method}`)) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    const res = await fetch(url, init);
    const data = await res.clone().json();

    if (url.pathname.endsWith('/xrpc/app.bsky.feed.getPosts')) {
      for (const post of data.posts ?? []) posts[post.uri] = post;
    }
    if (url.hostname === 'constellation.microcosm.blue') {
      constellation[url.searchParams.get('target')] = (data.linking_records ?? []).map(
        (r) => `at://${r.did}/${r.collection}/${r.rkey}`,
      );
    }
    return res;
  };
}

// ------------------------------------------------------------ 3. anonymize

/*
 * One mapping shared by every file, so cross-references survive: a DID rewritten
 * in a thread payload gets the same replacement as its key in posts.json.
 * Replacements are issued in order of first appearance, which keeps re-recording
 * from churning the diff.
 */
const seen = new Map();
const counters = {};

function alias(kind, value, make) {
  const key = `${kind}:${value}`;
  if (!seen.has(key)) {
    counters[kind] = (counters[kind] ?? 0) + 1;
    seen.set(key, make(counters[kind]));
  }
  return seen.get(key);
}

const pad = (n, width) => String(n).padStart(width, '0');

// did:plc identifiers are 24 characters after the prefix.
const fakeDid = (value) => alias('did', value, (n) => `did:plc:${'a'.repeat(20)}${pad(n, 4)}`);
// did:web identifiers embed the account's own domain, so they need replacing too.
const fakeWebDid = (value) => alias('did', value, (n) => `did:web:host${pad(n, 4)}.example`);
// Record keys are 13-character TIDs.
const fakeRkey = (value) => alias('rkey', value, (n) => `3${'a'.repeat(8)}${pad(n, 4)}`);
const fakeCid = (value) => alias('cid', value, (n) => `bafyrei${'a'.repeat(45)}${pad(n, 4)}`);
const fakeHandle = (value) => alias('handle', value, (n) => `user${pad(n, 4)}.example`);
const fakeName = (value) => alias('name', value, (n) => `Test User ${pad(n, 4)}`);
const fakeText = (value) => alias('text', value, (n) => `Sample post text ${pad(n, 4)}`);

/** Collect handles first, so they can be replaced wherever they are mentioned. */
function collectHandles(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const child of node) collectHandles(child, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  if (typeof node.handle === 'string') found.add(node.handle);
  for (const key of Object.keys(node)) collectHandles(node[key], found);
  return found;
}

function rewriteString(value, handles) {
  let out = value
    .replace(/did:plc:[a-z0-9]+/g, (did) => fakeDid(did))
    .replace(/did:web:[a-zA-Z0-9.:%-]+/g, (did) => fakeWebDid(did))
    .replace(/\bbaf[a-z0-9]{20,}/g, (cid) => fakeCid(cid))
    .replace(/(app\.bsky\.[a-z.]+\/)([a-z0-9]{13})/g, (_, prefix, rkey) => prefix + fakeRkey(rkey));
  for (const handle of handles) out = out.split(handle).join(fakeHandle(handle));
  return out;
}

/*
 * Timestamps are identifying on their own. An account's `createdAt` is
 * millisecond-precision and served publicly by the AppView, so it maps an
 * otherwise anonymous author straight back to the real account.
 *
 * They are assigned in chronological order rather than order of appearance, so
 * the fixtures keep the same relative ordering the live data had.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SYNTHETIC_EPOCH = Date.UTC(2020, 0, 1);
const timestamps = new Map();

function planTimestamps(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const child of node) planTimestamps(child, found);
    return found;
  }
  if (typeof node === 'string') {
    if (ISO_TIMESTAMP.test(node)) found.add(node);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  for (const key of Object.keys(node)) planTimestamps(node[key], found);
  return found;
}

function sealTimestamps(found) {
  [...found].sort().forEach((value, index) => {
    timestamps.set(value, new Date(SYNTHETIC_EPOCH + index * 60_000).toISOString());
  });
}

const fakeUrl = (value) => alias('url', value, (n) => `https://example.com/link/${pad(n, 4)}`);

/*
 * Keys whose string values are protocol structure rather than anything a person
 * wrote: identifiers, timestamps, enums. They still go through rewriteString,
 * which maps any DID, CID or record key inside them.
 *
 * Everything not listed here is treated as personal content and replaced. That
 * direction matters: an allowlist fails safe when Bluesky adds a field, whereas
 * enumerating the fields to scrub leaks each new one. It already did — a
 * profile's `messageMeUrl` and `pronouns` survived the first version of this.
 */
const STRUCTURAL_KEYS = new Set([
  '$type', '$link', 'uri', 'cid', 'did', 'src', 'val', 'via', 'mimeType',
  'createdAt', 'indexedAt', 'cts', 'expiresAt', 'lang',
  'allowIncoming', 'allowSubscriptions', 'allowGroupInvites', 'showButtonTo',
]);

const isUrl = (value) => /^https?:\/\//.test(value);
// Blob URLs are rebuilt from the DID and CID we already map, so they stay.
const isBlobUrl = (value) => value.startsWith('https://cdn.bsky.app/img/');

function anonymize(node, handles) {
  if (Array.isArray(node)) return node.map((child) => anonymize(child, handles));
  if (typeof node === 'string') return rewriteString(node, handles);
  if (!node || typeof node !== 'object') return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== 'string' || !value) out[key] = anonymize(value, handles);
    else if (timestamps.has(value)) out[key] = timestamps.get(value);
    else if (STRUCTURAL_KEYS.has(key)) out[key] = rewriteString(value, handles);
    else if (key === 'handle') out[key] = fakeHandle(value);
    else if (key === 'displayName') out[key] = fakeName(value);
    else if (isUrl(value)) out[key] = isBlobUrl(value) ? rewriteString(value, handles) : fakeUrl(value);
    else out[key] = fakeText(value);
  }
  return out;
}

/** Refuse to write anything that still looks like live data. */
function assertClean(label, data) {
  const json = JSON.stringify(data);
  const leaks = [
    ...(json.match(/https?:\\?\/\\?\/(?!cdn\.bsky\.app\/img\/|example\.com\/link\/)[^"\\]+/g) ?? []),
    ...(json.match(/did:plc:(?!a{20}\d{4})[a-z0-9]+/g) ?? []),
    ...(json.match(/did:web:(?!host\d{4}\.example)[a-zA-Z0-9.:%-]+/g) ?? []),
    // Anything still on a real clock rather than the synthetic epoch.
    ...(json.match(/"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z"/g) ?? []).filter(
      (stamp) => !stamp.startsWith('"2020-'),
    ),
  ];
  if (leaks.length) {
    throw new Error(`${label} still contains live data: ${[...new Set(leaks)].slice(0, 5).join(', ')}`);
  }
}

// ------------------------------------------------------------------- run

const captured = [];
for (const source of SOURCES) {
  captured.push({ ...source, payload: await capture(source) });
  console.log(`captured ${source.file}`);
}

for (const { file, method, payload } of captured) {
  const app = loadInterceptor(recordingNetwork(method, payload), {
    config: { enabled: true, deepRecovery: true },
  });
  await app.call(method, '?recording=1');
  console.log(`replayed ${file}: ${JSON.stringify(app.stats)}`);
}

// Handles are gathered across everything first so a mention inside one payload
// is rewritten the same way as the profile it refers to in another.
const everything = [...captured.map((c) => c.payload), posts];

// Aliases are issued in appearance order so re-recording does not churn the
// diff; replacement then runs longest-first so one handle is never rewritten
// inside another. Sorting the list used for both would tie the numbering to
// handle length, and one account renaming would rewrite every fixture.
const discovered = [...collectHandles(everything)];
for (const handle of discovered) fakeHandle(handle);
const handles = [...discovered].sort((a, b) => b.length - a.length);

sealTimestamps(planTimestamps(everything));

for (const { file, payload } of captured) write(file, anonymize(payload, handles));

const anonPosts = {};
for (const [uri, post] of Object.entries(posts).sort()) {
  const clean = anonymize(post, handles);
  anonPosts[clean.uri] = clean;
}
write('posts.json', anonPosts);

const anonLinks = {};
for (const [target, children] of Object.entries(constellation).sort()) {
  anonLinks[rewriteString(target, handles)] = children.map((c) => rewriteString(c, handles));
}
write('constellation.json', anonLinks);

console.log(
  `\nwrote ${captured.length} payloads, ${Object.keys(anonPosts).length} posts, ` +
    `${Object.keys(anonLinks).length} backlink targets — all anonymized`,
);
