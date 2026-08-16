/*
 * Re-records the resolver fixtures (`posts.json`, `constellation.json`) from the
 * captured API responses in test/fixtures, so the offline tests stay in sync with
 * whatever the payload fixtures actually contain.
 *
 *   node scripts/record-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const APPVIEW = 'https://public.api.bsky.app/xrpc';
const CONSTELLATION = 'https://constellation.microcosm.blue';

const PAYLOADS = [
  'thread-v2-blocked-quote.json',
  'thread-v2-blocked-reply.json',
  'thread-v2-hidden-reply.json',
  'thread-v1-blocked-quote.json',
  'thread-v1-blocked-parent.json',
  'feed-blocked-parent.json',
];

const read = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const write = (name, data) =>
  fs.writeFileSync(path.join(FIXTURES, name), `${JSON.stringify(data, null, 2)}\n`);

function collectBlockedUris(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const child of node) collectBlockedUris(child, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  const type = node.$type;
  const blockedStub = type === 'app.bsky.embed.record#viewBlocked' || type === 'app.bsky.feed.defs#blockedPost';
  const blockedItem = node.value?.$type === 'app.bsky.unspecced.defs#threadItemBlocked';
  if ((blockedStub || blockedItem) && typeof node.uri === 'string') found.add(node.uri);
  for (const key of Object.keys(node)) collectBlockedUris(node[key], found);
  return found;
}

/** Thread items whose replyCount exceeds what the response actually contains. */
function deepTargets(payload) {
  const items = payload.thread;
  if (!Array.isArray(items)) return [];
  return items
    .filter((item, i) => {
      if (item.value?.$type !== 'app.bsky.unspecced.defs#threadItemPost') return false;
      const shown = items.filter((o, j) => j > i && o.depth === item.depth + 1).length;
      const expected = item.value.post?.replyCount ?? 0;
      return expected - shown - (item.value.moreReplies ?? 0) > 0;
    })
    .map((item) => item.uri);
}

const wantedPosts = new Set();
const wantedLinks = new Set();

for (const name of PAYLOADS) {
  const payload = read(name);
  for (const uri of collectBlockedUris(payload)) wantedPosts.add(uri);
  for (const uri of deepTargets(payload)) wantedLinks.add(uri);
}

const constellation = {};
for (const target of wantedLinks) {
  const query =
    `target=${encodeURIComponent(target)}&collection=app.bsky.feed.post&path=.reply.parent.uri&limit=50`;
  const data = await fetch(`${CONSTELLATION}/links?${query}`).then((r) => r.json());
  const children = (data.linking_records ?? []).map((r) => `at://${r.did}/${r.collection}/${r.rkey}`);
  constellation[target] = children;
  for (const uri of children) wantedPosts.add(uri);
}
write('constellation.json', constellation);

const posts = {};
const uris = [...wantedPosts];
for (let i = 0; i < uris.length; i += 25) {
  const query = uris.slice(i, i + 25).map((u) => `uris=${encodeURIComponent(u)}`).join('&');
  const data = await fetch(`${APPVIEW}/app.bsky.feed.getPosts?${query}`).then((r) => r.json());
  for (const post of data.posts ?? []) posts[post.uri] = post;
}
write('posts.json', posts);

console.log(`recorded ${Object.keys(posts).length} posts, ${Object.keys(constellation).length} backlink targets`);
