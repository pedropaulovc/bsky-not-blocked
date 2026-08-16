/*
 * The whole extension rests on one claim about Bluesky's API:
 *
 *   Block filtering is scoped to the *relationship* between two records, not to
 *   the record itself. Ask the public AppView for a blocked post on its own and
 *   it comes back in full, unauthenticated.
 *
 * That is an observation about a live service, not a law, so it gets a re-runnable
 * check rather than a comment. Off by default; run with `npm run test:live`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const LIVE = process.env.BSKY_NOT_BLOCKED_LIVE === '1';
const APPVIEW = 'https://public.api.bsky.app/xrpc';

// ed3d.net quotes skity.bsky.social; the two accounts block each other.
const QUOTING = 'at://did:plc:klhtmrnregub7we7h6jwiljm/app.bsky.feed.post/3mt5jmqs4n22n';
const QUOTED = 'at://did:plc:v4sghlfldhg56z6ckpnw2kvj/app.bsky.feed.post/3mt3tm576mk2y';

const get = (method, query) => fetch(`${APPVIEW}/${method}?${query}`).then((r) => r.json());

test('the AppView still hides the quote from third parties', { skip: !LIVE }, async () => {
  const thread = await get('app.bsky.unspecced.getPostThreadV2', `anchor=${encodeURIComponent(QUOTING)}`);
  const embed = thread.thread[0].value.post.embed.record;
  assert.equal(embed.$type, 'app.bsky.embed.record#viewBlocked', 'premise gone: the post is no longer hidden');
  assert.equal(embed.uri, QUOTED, 'the stub still names the post it hides');
});

test('...but hands it over when asked for directly', { skip: !LIVE }, async () => {
  const { posts } = await get('app.bsky.feed.getPosts', `uris=${encodeURIComponent(QUOTED)}`);
  assert.equal(posts.length, 1, 'getPosts no longer returns blocked posts — the extension cannot work');
  assert.equal(posts[0].uri, QUOTED);
  assert.ok(posts[0].record.text.length > 0);
  assert.ok(posts[0].author.handle);
});

test('the AppView drops blocked replies without leaving a stub', { skip: !LIVE }, async () => {
  // aly.codes' post has one reply, from an account it blocks. The reply is not
  // stubbed the way a blocked parent is — it is simply absent, which is why
  // recovering it needs an external index.
  const target = 'at://did:plc:zntngpowgd6rorjt3haywj36/app.bsky.feed.post/3mt5l6lu5ec22';
  const thread = await get('app.bsky.unspecced.getPostThreadV2', `anchor=${encodeURIComponent(target)}&below=6`);
  const anchor = thread.thread.find((item) => item.depth === 0);

  assert.ok(anchor.value.post.replyCount > 0, 'the post still claims replies');
  assert.equal(thread.thread.filter((item) => item.depth === 1).length, 0, 'and still returns none');
});

test('the backlink index can still name the dropped reply', { skip: !LIVE }, async () => {
  const target = 'at://did:plc:zntngpowgd6rorjt3haywj36/app.bsky.feed.post/3mt5l6lu5ec22';
  const query = `target=${encodeURIComponent(target)}&collection=app.bsky.feed.post&path=.reply.parent.uri`;
  const data = await fetch(`https://constellation.microcosm.blue/links?${query}`).then((r) => r.json());

  assert.ok(data.linking_records?.length > 0, 'backlink index returned nothing — deep recovery is dead');
});
