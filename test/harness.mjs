/*
 * Loads the real src/interceptor.js into a sandboxed page-like context, so the
 * tests exercise the exact file that ships rather than a re-implementation.
 *
 * Network is served from test/fixtures by default. Pass `live: true` to let the
 * resolver hit the real AppView, which is how you re-check the assumption that
 * unauthenticated getPosts still returns blocked posts.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const SOURCE = path.join(ROOT, 'src', 'interceptor.js');

export const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/**
 * Stands in for the network. `payloads` maps an XRPC method name to the response
 * the app would have received; getPosts and the backlink index are answered from
 * the recorded fixtures.
 */
export function mockNetwork({ payloads = {}, posts = fixture('posts.json'), links = fixture('constellation.json') } = {}) {
  const calls = [];

  const inits = [];

  return {
    calls,
    inits,
    async fetch(input, init) {
      const url = new URL(typeof input === 'string' ? input : input.url);
      calls.push(url.toString());
      inits.push(init);

      if (url.pathname.endsWith('/xrpc/app.bsky.feed.getPosts')) {
        const wanted = url.searchParams.getAll('uris');
        return json({ posts: wanted.map((uri) => posts[uri]).filter(Boolean) });
      }

      if (url.hostname === 'constellation.microcosm.blue') {
        const target = url.searchParams.get('target');
        const children = links[target] ?? [];
        return json({
          total: children.length,
          linking_records: children.map((uri) => {
            const [, , did, collection, rkey] = uri.split('/');
            return { did, collection, rkey };
          }),
          cursor: null,
        });
      }

      const method = url.pathname.split('/xrpc/')[1];
      if (method in payloads) return json(payloads[method]);

      throw new Error(`unexpected request: ${url}`);
    },
  };
}

export function loadInterceptor(networkFetch, { config } = {}) {
  const messageListeners = [];
  const origin = 'https://bsky.app';

  const window = {
    fetch: networkFetch,
    location: { href: `${origin}/`, origin },
    addEventListener(type, handler) {
      if (type === 'message') messageListeners.push(handler);
    },
  };

  const sandbox = {
    window,
    console,
    URL,
    Request,
    Response,
    Headers,
    TextEncoder,
    AbortController,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), sandbox, { filename: 'src/interceptor.js' });

  const setConfig = (next) => {
    for (const handler of messageListeners) {
      handler({ source: window, data: { source: 'bsky-not-blocked', type: 'config', config: next } });
    }
  };
  if (config) setConfig(config);

  return {
    setConfig,
    stats: window.__bskyNotBlocked.stats,
    /** Calls the patched fetch and returns the parsed (possibly repaired) payload. */
    async call(method, query = '') {
      const res = await window.fetch(`https://public.api.bsky.app/xrpc/${method}${query}`);
      return res.json();
    },
  };
}

/** Every `$type` present anywhere in a payload, for shape assertions. */
export function types(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const child of node) types(child, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  if (typeof node.$type === 'string') found.add(node.$type);
  for (const key of Object.keys(node)) types(node[key], found);
  return found;
}
