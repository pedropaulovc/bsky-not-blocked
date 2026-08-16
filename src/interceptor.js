/*
 * bsky-not-blocked — page-world fetch interceptor.
 *
 * Bluesky applies block relationships symmetrically and *publicly*: if A blocks B,
 * then B's reply to A, and A's quote of B, are hidden from everyone — including
 * third parties who are blocked by neither account. This restores that content for
 * the local viewer by repairing the AppView response before the app renders it.
 *
 * Nothing here is privileged. Every blocked stub carries the AT-URI of the post it
 * is hiding, and an unauthenticated `app.bsky.feed.getPosts` on that URI returns the
 * post fully hydrated — the filtering is relationship-scoped, not record-scoped.
 *
 * Runs in the MAIN world so it can patch the same `window.fetch` the app's XRPC
 * client uses. It only ever rewrites the response body; requests pass through
 * untouched, and any error falls through to the original response.
 */
(() => {
  'use strict';

  const NAMESPACE = '__bskyNotBlocked';
  if (window[NAMESPACE]) return;

  const APPVIEW = 'https://public.api.bsky.app/xrpc';
  const CONSTELLATION = 'https://constellation.microcosm.blue';

  const EMBED_BLOCKED = 'app.bsky.embed.record#viewBlocked';
  const EMBED_RECORD = 'app.bsky.embed.record#viewRecord';
  const BLOCKED_POST = 'app.bsky.feed.defs#blockedPost';
  const THREAD_VIEW_POST = 'app.bsky.feed.defs#threadViewPost';
  const POST_VIEW = 'app.bsky.feed.defs#postView';
  const ITEM_BLOCKED = 'app.bsky.unspecced.defs#threadItemBlocked';
  const ITEM_POST = 'app.bsky.unspecced.defs#threadItemPost';

  // getPosts caps out at 25 URIs per call.
  const GET_POSTS_LIMIT = 25;
  // A restored post can itself quote a blocked post; re-run until the payload settles.
  const MAX_PASSES = 3;
  // Ceilings on the extra work a single response can trigger.
  const MAX_DEEP_TARGETS = 24;
  const DEEP_CONCURRENCY = 4;
  const DEEP_PAGE_SIZE = 50;

  const config = { enabled: true, deepRecovery: false, debug: false };

  // Bound before patching, so our own lookups never re-enter the interceptor.
  const originalFetch = window.fetch.bind(window);

  /** uri -> postView, or null when the AppView confirmed it is gone. */
  const postCache = new Map();
  /** uri -> array of child post URIs, from the backlink index. */
  const backlinkCache = new Map();

  const stats = { restoredQuotes: 0, restoredPosts: 0, recoveredReplies: 0 };

  const log = (...args) => {
    if (config.debug) console.info('[bsky-not-blocked]', ...args);
  };

  window[NAMESPACE] = { config, stats, postCache };

  // ---------------------------------------------------------------- config

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'bsky-not-blocked' || data.type !== 'config') return;
    Object.assign(config, data.config);
    log('config', config);
  });

  // ------------------------------------------------------------ conversion

  /** A postView from getPosts, tagged so it validates in union positions. */
  function toPostView(post) {
    return { ...post, $type: POST_VIEW };
  }

  /** postView -> the flattened shape a quote embed expects. */
  function toViewRecord(post) {
    return {
      $type: EMBED_RECORD,
      uri: post.uri,
      cid: post.cid,
      author: post.author,
      value: post.record,
      labels: post.labels ?? [],
      replyCount: post.replyCount ?? 0,
      repostCount: post.repostCount ?? 0,
      likeCount: post.likeCount ?? 0,
      quoteCount: post.quoteCount ?? 0,
      embeds: post.embed ? [post.embed] : [],
      indexedAt: post.indexedAt,
    };
  }

  function toThreadItemPost(post) {
    return {
      $type: ITEM_POST,
      post: toPostView(post),
      moreParents: false,
      moreReplies: 0,
      opThread: false,
      hiddenByThreadgate: false,
      mutedByViewer: false,
    };
  }

  // -------------------------------------------------------------- scanning

  function isBlockedThreadItem(node) {
    return typeof node?.uri === 'string' && node?.value?.$type === ITEM_BLOCKED;
  }

  /** Walk any XRPC payload and collect the AT-URIs hidden behind blocked stubs. */
  function collectBlockedUris(node, found = new Set()) {
    if (Array.isArray(node)) {
      for (const child of node) collectBlockedUris(child, found);
      return found;
    }
    if (!node || typeof node !== 'object') return found;

    const type = node.$type;
    if ((type === EMBED_BLOCKED || type === BLOCKED_POST) && typeof node.uri === 'string') {
      found.add(node.uri);
    } else if (isBlockedThreadItem(node)) {
      found.add(node.uri);
    }

    for (const key of Object.keys(node)) collectBlockedUris(node[key], found);
    return found;
  }

  /**
   * Replace every resolved blocked stub with the real content.
   *
   * `wrapThread` selects the union shape expected at the splice point: thread
   * endpoints want a threadViewPost, whereas a feed's `reply.parent` / `reply.root`
   * wants a bare postView. Getting this backwards blanks the row.
   */
  function restore(node, wrapThread) {
    if (Array.isArray(node)) return node.map((child) => restore(child, wrapThread));
    if (!node || typeof node !== 'object') return node;

    const post = typeof node.uri === 'string' ? postCache.get(node.uri) : undefined;

    if (node.$type === EMBED_BLOCKED && post) {
      stats.restoredQuotes++;
      return toViewRecord(post);
    }

    if (node.$type === BLOCKED_POST && post) {
      stats.restoredPosts++;
      return wrapThread
        ? { $type: THREAD_VIEW_POST, post: toPostView(post), replies: [] }
        : toPostView(post);
    }

    if (isBlockedThreadItem(node) && post) {
      stats.restoredPosts++;
      return { ...node, value: toThreadItemPost(post) };
    }

    const out = {};
    for (const key of Object.keys(node)) out[key] = restore(node[key], wrapThread);
    return out;
  }

  // ------------------------------------------------------------- resolving

  async function fetchJson(url) {
    const res = await originalFetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }

  /**
   * Hydrate blocked URIs via the public AppView. Requested standalone, a post
   * carries no relationship to the account that blocked its author, so it comes
   * back in full.
   */
  async function resolvePosts(uris) {
    const pending = [...new Set(uris)].filter((uri) => !postCache.has(uri));
    if (!pending.length) return;

    for (let i = 0; i < pending.length; i += GET_POSTS_LIMIT) {
      const chunk = pending.slice(i, i + GET_POSTS_LIMIT);
      const query = chunk.map((uri) => `uris=${encodeURIComponent(uri)}`).join('&');
      let data;
      try {
        data = await fetchJson(`${APPVIEW}/app.bsky.feed.getPosts?${query}`);
      } catch (err) {
        // Transient failure — leave uncached so a later response can retry.
        log('getPosts failed', err.message);
        continue;
      }
      const byUri = new Map((data.posts ?? []).map((post) => [post.uri, post]));
      // A confirmed miss (deleted or taken down) is cached as null so we stop asking.
      for (const uri of chunk) postCache.set(uri, byUri.get(uri) ?? null);
    }
  }

  // -------------------------------------------------- deep reply recovery

  /**
   * Blocked *replies* are not stubbed the way blocked parents and quotes are —
   * the AppView drops them from the thread entirely, so the response gives us no
   * URI to resolve. The only trace left is an inflated `replyCount`.
   *
   * A backlink index over the firehose can name the missing children. This is
   * opt-in because it means sending post URIs to a third-party service.
   */
  async function backlinkChildren(uri) {
    if (backlinkCache.has(uri)) return backlinkCache.get(uri);
    const query =
      `target=${encodeURIComponent(uri)}` +
      `&collection=app.bsky.feed.post&path=.reply.parent.uri&limit=${DEEP_PAGE_SIZE}`;
    let children = [];
    try {
      const data = await fetchJson(`${CONSTELLATION}/links?${query}`);
      children = (data.linking_records ?? []).map(
        (rec) => `at://${rec.did}/${rec.collection}/${rec.rkey}`,
      );
    } catch (err) {
      log('backlink lookup failed', uri, err.message);
      return [];
    }
    backlinkCache.set(uri, children);
    return children;
  }

  /** Direct children of each item in a flat, depth-annotated thread. */
  function countChildren(items) {
    const counts = new Map();
    for (let i = 0; i < items.length; i++) {
      const depth = items[i].depth;
      let children = 0;
      for (let j = i + 1; j < items.length; j++) {
        if (items[j].depth <= depth) break;
        if (items[j].depth === depth + 1) children++;
      }
      counts.set(items[i].uri, children);
    }
    return counts;
  }

  /** Index just past the last descendant of the item at `index`. */
  function endOfSubtree(items, index) {
    const depth = items[index].depth;
    let end = index + 1;
    while (end < items.length && items[end].depth > depth) end++;
    return end;
  }

  async function mapLimit(values, limit, worker) {
    const results = [];
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await worker(values[index]);
      }
    });
    await Promise.all(runners);
    return results;
  }

  async function recoverHiddenReplies(payload) {
    const items = payload.thread;
    if (!Array.isArray(items) || !items.length) return false;

    const present = new Set(items.map((item) => item.uri));
    const counts = countChildren(items);

    // `moreReplies` accounts for replies the server deliberately paginated away.
    // Anything still unaccounted for was filtered out, which is what we're after.
    const targets = items.filter((item) => {
      if (item.value?.$type !== ITEM_POST) return false;
      const expected = item.value.post?.replyCount ?? 0;
      const shown = counts.get(item.uri) ?? 0;
      const paginated = item.value.moreReplies ?? 0;
      return expected - shown - paginated > 0;
    });
    if (!targets.length) return false;

    const capped = targets.slice(0, MAX_DEEP_TARGETS);
    if (capped.length < targets.length) {
      log(`deep recovery capped at ${MAX_DEEP_TARGETS} of ${targets.length} candidates`);
    }

    const lookups = await mapLimit(capped, DEEP_CONCURRENCY, async (item) => ({
      item,
      missing: (await backlinkChildren(item.uri)).filter((uri) => !present.has(uri)),
    }));

    const wanted = lookups.flatMap((entry) => entry.missing);
    if (!wanted.length) return false;
    await resolvePosts(wanted);

    // Splice children in after their parent's existing subtree, deepest parents
    // first so earlier insertions don't invalidate later indices.
    const insertions = [];
    for (const { item, missing } of lookups) {
      const posts = missing.map((uri) => postCache.get(uri)).filter(Boolean);
      if (!posts.length) continue;
      const index = items.indexOf(item);
      if (index < 0) continue;
      insertions.push({
        at: endOfSubtree(items, index),
        rows: posts.map((post) => ({
          uri: post.uri,
          depth: item.depth + 1,
          value: toThreadItemPost(post),
        })),
      });
    }
    if (!insertions.length) return false;

    insertions.sort((a, b) => b.at - a.at);
    for (const { at, rows } of insertions) {
      items.splice(at, 0, ...rows);
      stats.recoveredReplies += rows.length;
    }
    return true;
  }

  // -------------------------------------------------------------- rewriting

  async function rewrite(payload, kind) {
    let data = payload;
    let changed = false;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const blocked = [...collectBlockedUris(data)];
      if (!blocked.length) break;
      await resolvePosts(blocked);

      const before = stats.restoredQuotes + stats.restoredPosts;
      data = restore(data, kind === 'thread-v1');
      if (stats.restoredQuotes + stats.restoredPosts === before) break;
      changed = true;
    }

    if (config.deepRecovery && kind === 'thread-v2' && (await recoverHiddenReplies(data))) {
      changed = true;
    }

    return { data, changed };
  }

  // ------------------------------------------------------------ interception

  function classify(url) {
    const path = url.pathname;
    if (!path.includes('/xrpc/app.bsky.')) return null;
    if (path.endsWith('app.bsky.unspecced.getPostThreadV2')) return 'thread-v2';
    if (path.endsWith('app.bsky.unspecced.getPostThreadOtherV2')) return 'thread-v2';
    if (path.endsWith('app.bsky.feed.getPostThread')) return 'thread-v1';
    return 'other';
  }

  function requestUrl(input) {
    const raw = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input?.url ?? input);
    return new URL(raw, window.location.href);
  }

  /** Cheap pre-parse test, so untouched responses cost almost nothing. */
  function mightNeedWork(body, kind) {
    if (body.includes('"blocked":true') || body.includes(ITEM_BLOCKED)) return true;
    return config.deepRecovery && kind === 'thread-v2';
  }

  function replaceBody(original, data) {
    const headers = new Headers(original.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    const patched = new Response(JSON.stringify(data), {
      status: original.status,
      statusText: original.statusText,
      headers,
    });
    try {
      Object.defineProperty(patched, 'url', { value: original.url });
    } catch {
      /* non-fatal: some engines lock this down */
    }
    return patched;
  }

  window.fetch = async function bskyNotBlockedFetch(input, init) {
    const response = await originalFetch(input, init);
    if (!config.enabled) return response;

    try {
      if (!response.ok) return response;
      const kind = classify(requestUrl(input));
      if (!kind) return response;
      if (!(response.headers.get('content-type') ?? '').includes('json')) return response;

      const body = await response.clone().text();
      if (!mightNeedWork(body, kind)) return response;

      const { data, changed } = await rewrite(JSON.parse(body), kind);
      if (!changed) return response;

      log('restored', stats);
      return replaceBody(response, data);
    } catch (err) {
      // Fail open: a broken interceptor must never break Bluesky.
      console.warn('[bsky-not-blocked] passing response through unchanged:', err);
      return response;
    }
  };

  log('active');
})();
