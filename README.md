# Bluesky: Not Blocked

A Firefox and Chromium extension that restores Bluesky posts hidden from you only because two **other** accounts block each other.

Bluesky applies blocks publicly and symmetrically. If A blocks B, then A's quote of B and B's reply to A disappear for *everyone* — including people neither account has blocked. Threads end up full of "Blocked" placeholders and silent gaps that have nothing to do with you.

[This thread](https://bsky.app/profile/ed3d.net/post/3mt5jmqs4n22n) is the usual shape: the post quotes something, and the quote is a grey box.

## What it does

The extension patches the JSON coming back from Bluesky's API before the app renders it, so restored posts appear as ordinary posts — no separate panel, no injected markup.

| Hidden as | Restored |
| --- | --- |
| A blocked quote post (grey `Blocked` card) | The real quoted post, with author, text, and media |
| A blocked parent in a thread | The real parent, in place, at its original depth |
| A blocked reply parent in feeds | The real post above the reply |
| A blocked reply in a thread | Only with **Recover hidden replies** on — see below |

## Install

```sh
git clone https://github.com/pedropaulovc/bsky-not-blocked
cd bsky-not-blocked
node scripts/build.mjs
```

No dependencies and no build tooling — the script copies `src/` next to the right manifest.

**Chrome / Edge / Brave** — `chrome://extensions` → enable Developer mode → *Load unpacked* → `dist/chrome`.

**Firefox 140+** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `dist/firefox/manifest.json`. Temporary add-ons are removed when Firefox restarts; a permanently installed copy needs Mozilla signing, which this repo does not do for you.

Then open a Bluesky thread. There is nothing to configure for the default behaviour.

## How it works

Blocked content is not withheld from you — it is withheld from a *relationship*. Every placeholder Bluesky renders still carries the AT-URI of the post behind it, and asking the public AppView for that URI on its own returns the post in full, unauthenticated:

```sh
curl "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=at://did:plc:v4sghlfldhg56z6ckpnw2kvj/app.bsky.feed.post/3mt3tm576mk2y"
```

So the extension patches `window.fetch` in the page, watches for XRPC responses containing blocked stubs, resolves them in one batched call, and splices the real posts back into the response. The app renders them natively because by the time it sees the data, nothing is marked blocked.

That claim about the API is the load-bearing one, so it has a re-runnable check rather than a comment: `npm run test:live`.

### Why the content script must run at `document_start`

Bluesky's bundle snapshots fetch into a module constant the moment it evaluates:

```js
let P = globalThis.fetch
```

So patching fetch *after* the app has loaded does nothing at all — the app goes on using the reference it already took. The extension works only because a `world: "MAIN"` content script at `run_at: "document_start"` runs before the bundle does, which means it is the patched fetch that gets snapshotted.

That ordering is invisible to the unit tests and easy to break, so it has its own browser-driven check: `npm run test:e2e`.

## Recover hidden replies (off by default)

Blocked *replies* are handled differently by the API: instead of a placeholder, they are dropped from the thread entirely. The response leaves no URI to resolve — the only trace is a `replyCount` larger than the number of replies actually returned.

Naming those posts needs an index built from the firehose. With this option on, the extension asks [constellation.microcosm.blue](https://constellation.microcosm.blue) which posts reply to the ones in your thread, and restores any the AppView withheld.

It is opt-in because it sends post URIs to a third party. With it off, the extension talks to nothing but Bluesky's own API.

## Scope and limits

- **Nothing here is privileged.** Only public, unauthenticated endpoints are used, and your session token is never read or sent. The extension asks for one permission, `storage`, to remember the toggles.
- **It does not touch your own blocks.** Accounts *you* block, and accounts that block *you*, stay hidden. Those posts are not resolvable this way, and un-hiding them is not what this is for.
- **Restored posts are not visually marked.** They are spliced into the data, so they look like any other post. Distinguishing them would mean injecting markup into Bluesky's UI, which is the fragile approach this design avoids.
- **Deleted posts stay hidden.** If a post is gone or taken down, there is nothing to restore and the placeholder remains.
- Interception targets the XRPC calls Bluesky's web app makes (`getPostThreadV2`, `getPostThread`, and the feed endpoints). Anything else passes through untouched, as does every response when an error occurs — the extension fails open by design.

## Development

```sh
npm run build             # dist/{chrome,firefox} plus zips — no dependencies needed
npm test                  # offline, against recorded API fixtures
npm run test:live         # re-checks the API assumptions against Bluesky
npm run test:e2e          # loads the built extension into Chrome, hits the real site
npm run lint:firefox      # web-ext lint on the Firefox build
npm run record-fixtures   # refresh fixtures after an API change
```

Building needs nothing installed. The tests beyond `npm test` need `npm i` (Playwright for the end-to-end run, `web-ext` for the Firefox lint).

`npm test` loads `src/interceptor.js` itself into a sandboxed page-like context, so it exercises the file that ships rather than a copy of its logic.

## License

MIT
