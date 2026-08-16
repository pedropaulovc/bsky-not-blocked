import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, loadInterceptor, mockNetwork, types } from './harness.mjs';

const THREAD_V2 = 'app.bsky.unspecced.getPostThreadV2';
const THREAD_V1 = 'app.bsky.feed.getPostThread';
const AUTHOR_FEED = 'app.bsky.feed.getAuthorFeed';

const QUOTED = 'at://did:plc:v4sghlfldhg56z6ckpnw2kvj/app.bsky.feed.post/3mt3tm576mk2y';
const BLOCKED_PARENT = 'at://did:plc:zntngpowgd6rorjt3haywj36/app.bsky.feed.post/3mt5l6lu5ec22';
const HIDDEN_REPLY = 'at://did:plc:v4sghlfldhg56z6ckpnw2kvj/app.bsky.feed.post/3mt5n422h422o';

const flat = (payload) => payload.thread.map((item) => [item.depth, item.value.$type, item.uri]);

test('restores a blocked quote embed in a v2 thread', async () => {
  const net = mockNetwork({ payloads: { [THREAD_V2]: fixture('thread-v2-blocked-quote.json') } });
  const app = loadInterceptor(net.fetch);

  const before = types(fixture('thread-v2-blocked-quote.json'));
  assert.ok(before.has('app.bsky.embed.record#viewBlocked'), 'fixture should start blocked');

  const after = types(await app.call(THREAD_V2, '?anchor=x'));
  assert.ok(!after.has('app.bsky.embed.record#viewBlocked'), 'blocked stub should be gone');
  assert.ok(after.has('app.bsky.embed.record#viewRecord'), 'quote should be a real record');
  assert.equal(app.stats.restoredQuotes, 1);
});

test('the restored quote carries the real author and text', async () => {
  const net = mockNetwork({ payloads: { [THREAD_V2]: fixture('thread-v2-blocked-quote.json') } });
  const app = loadInterceptor(net.fetch);

  const payload = await app.call(THREAD_V2, '?anchor=x');
  const quote = payload.thread[0].value.post.embed.record;

  assert.equal(quote.$type, 'app.bsky.embed.record#viewRecord');
  assert.equal(quote.uri, QUOTED);
  assert.equal(quote.author.handle, 'skity.bsky.social');
  assert.match(quote.value.text, /Coding is largely solved/);
  assert.ok(Array.isArray(quote.embeds), 'viewRecord.embeds must be an array');
});

test('restores a blocked parent in a v2 thread, keeping its depth', async () => {
  const net = mockNetwork({ payloads: { [THREAD_V2]: fixture('thread-v2-blocked-reply.json') } });
  const app = loadInterceptor(net.fetch);

  const payload = await app.call(THREAD_V2, '?anchor=x');
  const parent = payload.thread.find((item) => item.depth === -1);

  assert.equal(parent.value.$type, 'app.bsky.unspecced.defs#threadItemPost');
  assert.equal(parent.uri, BLOCKED_PARENT);
  assert.equal(parent.value.post.author.handle, 'aly.codes');
  assert.match(parent.value.post.record.text, /extremely normal analogy/);
  // threadItemPost has required fields the renderer reads unconditionally.
  for (const key of ['moreParents', 'moreReplies', 'opThread', 'hiddenByThreadgate', 'mutedByViewer']) {
    assert.ok(key in parent.value, `threadItemPost is missing ${key}`);
  }
});

test('v1 threads get a threadViewPost wrapper, not a bare postView', async () => {
  const net = mockNetwork({ payloads: { [THREAD_V1]: fixture('thread-v1-blocked-parent.json') } });
  const app = loadInterceptor(net.fetch);

  const payload = await app.call(THREAD_V1, '?uri=x');
  assert.equal(payload.thread.parent.$type, 'app.bsky.feed.defs#threadViewPost');
  assert.equal(payload.thread.parent.post.uri, BLOCKED_PARENT);
  assert.equal(payload.thread.parent.post.author.handle, 'aly.codes');
});

test('feed replies get a bare postView, not a threadViewPost', async () => {
  const net = mockNetwork({ payloads: { [AUTHOR_FEED]: fixture('feed-blocked-parent.json') } });
  const app = loadInterceptor(net.fetch);

  const payload = await app.call(AUTHOR_FEED, '?actor=x');
  const repaired = payload.feed.filter((entry) => entry.reply?.parent?.$type === 'app.bsky.feed.defs#postView');

  assert.ok(repaired.length > 0, 'at least one feed reply parent should be restored');
  for (const entry of repaired) {
    assert.ok(entry.reply.parent.record.text !== undefined, 'restored parent needs a record');
    assert.ok(entry.reply.parent.author.handle, 'restored parent needs an author');
  }
  assert.ok(!types(payload).has('app.bsky.feed.defs#threadViewPost'), 'feeds must not gain thread wrappers');
});

test('deep recovery pulls back a reply the AppView dropped entirely', async () => {
  const original = fixture('thread-v2-hidden-reply.json');
  assert.equal(original.thread.length, 1, 'fixture should show a lone post...');
  assert.equal(original.thread[0].value.post.replyCount, 1, '...that claims one reply');

  const net = mockNetwork({ payloads: { [THREAD_V2]: original } });
  const app = loadInterceptor(net.fetch, { config: { enabled: true, deepRecovery: true } });

  const payload = await app.call(THREAD_V2, '?anchor=x');
  assert.deepEqual(flat(payload), [
    [0, 'app.bsky.unspecced.defs#threadItemPost', BLOCKED_PARENT],
    [1, 'app.bsky.unspecced.defs#threadItemPost', HIDDEN_REPLY],
  ]);
  assert.equal(app.stats.recoveredReplies, 1);
});

test('deep recovery stays off unless enabled', async () => {
  const net = mockNetwork({ payloads: { [THREAD_V2]: fixture('thread-v2-hidden-reply.json') } });
  const app = loadInterceptor(net.fetch);

  const payload = await app.call(THREAD_V2, '?anchor=x');
  assert.equal(payload.thread.length, 1);
  assert.ok(!net.calls.some((url) => url.includes('constellation')), 'must not contact the backlink index');
});

test('disabled means byte-identical passthrough', async () => {
  const original = fixture('thread-v2-blocked-quote.json');
  const net = mockNetwork({ payloads: { [THREAD_V2]: original } });
  const app = loadInterceptor(net.fetch, { config: { enabled: false } });

  assert.deepEqual(await app.call(THREAD_V2, '?anchor=x'), original);
  assert.equal(net.calls.length, 1, 'no resolver traffic when disabled');
});

test('unrelated endpoints are never parsed or rewritten', async () => {
  const profile = { did: 'did:plc:x', handle: 'a.example', viewer: { blockedBy: true } };
  const net = mockNetwork({ payloads: { 'app.bsky.actor.getProfile': profile } });
  const app = loadInterceptor(net.fetch);

  assert.deepEqual(await app.call('app.bsky.actor.getProfile', '?actor=x'), profile);
  assert.equal(net.calls.length, 1, '"blockedBy" must not trigger a resolve');
});

test('a failing resolver leaves the response untouched', async () => {
  const original = fixture('thread-v2-blocked-quote.json');
  const net = mockNetwork({ payloads: { [THREAD_V2]: original } });
  const app = loadInterceptor(async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.endsWith('getPosts')) return new Response('nope', { status: 502 });
    return net.fetch(input);
  });

  assert.deepEqual(await app.call(THREAD_V2, '?anchor=x'), original);
});

test('a post the AppView no longer has is left blocked and asked for once', async () => {
  const net = mockNetwork({ payloads: { [THREAD_V2]: fixture('thread-v2-blocked-quote.json') }, posts: {} });
  const app = loadInterceptor(net.fetch);

  const payload = await app.call(THREAD_V2, '?anchor=x');
  assert.ok(types(payload).has('app.bsky.embed.record#viewBlocked'), 'stub stays when unresolvable');

  await app.call(THREAD_V2, '?anchor=x');
  const lookups = net.calls.filter((url) => url.includes('getPosts'));
  assert.equal(lookups.length, 1, 'a confirmed miss must be cached, not retried');
});

test('resolved posts are cached across requests', async () => {
  const net = mockNetwork({ payloads: { [THREAD_V2]: fixture('thread-v2-blocked-quote.json') } });
  const app = loadInterceptor(net.fetch);

  await app.call(THREAD_V2, '?anchor=x');
  await app.call(THREAD_V2, '?anchor=x');

  assert.equal(net.calls.filter((url) => url.includes('getPosts')).length, 1);
  assert.equal(app.stats.restoredQuotes, 2, 'still repaired on the second pass');
});
