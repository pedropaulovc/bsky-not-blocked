/*
 * Re-records the resolver fixtures (`posts.json`, `constellation.json`) from the
 * captured API responses in test/fixtures.
 *
 *   node scripts/record-fixtures.mjs
 *
 * Rather than scanning the payloads itself, this runs each one through the real
 * `src/interceptor.js` with deep recovery on and a network that proxies to the
 * live services, recording whatever the interceptor asks for. So the fixtures
 * are by construction exactly what the shipping code needs — there is no second
 * copy of the scanning rules here to drift out of step with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInterceptor } from '../test/harness.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

/** Each payload fixture, and the XRPC method whose response it stands in for. */
const PAYLOADS = {
  'thread-v2-blocked-quote.json': 'app.bsky.unspecced.getPostThreadV2',
  'thread-v2-blocked-reply.json': 'app.bsky.unspecced.getPostThreadV2',
  'thread-v2-hidden-reply.json': 'app.bsky.unspecced.getPostThreadV2',
  'thread-v1-blocked-quote.json': 'app.bsky.feed.getPostThread',
  'thread-v1-blocked-parent.json': 'app.bsky.feed.getPostThread',
  'feed-blocked-parent.json': 'app.bsky.feed.getAuthorFeed',
};

const read = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const write = (name, data) =>
  fs.writeFileSync(path.join(FIXTURES, name), `${JSON.stringify(data, null, 2)}\n`);

const posts = {};
const constellation = {};

/** Serves the payload under test locally; everything else goes to the real service and is kept. */
function recordingNetwork(payloadMethod, payload) {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);

    if (url.pathname.endsWith(`/xrpc/${payloadMethod}`)) {
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

for (const [name, method] of Object.entries(PAYLOADS)) {
  const app = loadInterceptor(recordingNetwork(method, read(name)), {
    config: { enabled: true, deepRecovery: true },
  });
  await app.call(method, '?recording=1');
  console.log(`${name}: ${JSON.stringify(app.stats)}`);
}

write('posts.json', Object.fromEntries(Object.keys(posts).sort().map((uri) => [uri, posts[uri]])));
write('constellation.json', constellation);

console.log(
  `\nrecorded ${Object.keys(posts).length} posts, ${Object.keys(constellation).length} backlink targets`,
);
