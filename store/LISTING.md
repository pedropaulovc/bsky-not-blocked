# Store listing copy

Paste-ready text for all three dashboards. Keep this file in sync when a listing
changes, so the published wording has a reviewable source rather than living
only in three web forms.

---

## Name

    Bluesky: Not Blocked

Edge and Chrome both allow 45 characters; AMO allows 50.

## Summary / short description

Chrome caps this at 132 characters. The line below is 113, and is reused
verbatim for Edge's short description and AMO's summary:

    Shows Bluesky posts hidden from you only because two other accounts block each other. Nothing is hidden from you.

## Category

- Chrome Web Store: **Social & Communication**
- Edge Add-ons: **Social**
- AMO: **Social & Communication**

---

## Detailed description

Used for all three. Plain text with blank lines between paragraphs — none of the
three stores render Markdown in the description field.

    On Bluesky, when two accounts block each other, their posts disappear for
    everyone — including people neither account has blocked. A quoted post turns
    into a grey "Blocked" box. A reply's parent vanishes from the thread. You end
    up reading half a conversation with no way to tell what is missing.

    This extension fills those gaps back in. When Bluesky sends the page a
    post it has hidden this way, the extension asks Bluesky's own public API for
    that post directly and puts the real content back into the thread. Bluesky
    then renders it normally, so restored posts look like every other post.

    WHAT IT DOES NOT DO

    It does not touch blocks that involve you. If you block someone, or someone
    blocks you, their posts stay hidden — the extension has no way to reach them
    and does not try. It only restores posts that are already public to you and
    were withheld because of a block between two other people.

    It reads nothing but the API responses Bluesky's own web app requests. It
    never sees your password, never uses your login, and works while you are
    signed out. Every post it recovers comes from Bluesky's public, unauthenticated
    API — the same endpoint anyone can query without an account.

    PRIVACY

    No data collection of any kind. No analytics, no telemetry, no remote servers,
    no accounts. Nothing about your browsing leaves your machine. The only network
    requests it makes are to Bluesky's public API, for the specific posts a page is
    already trying to show you.

    CONTROLS

    A toolbar popup with three switches:

    - On/off — pause the extension without uninstalling it.
    - Deep recovery — off by default. Also recovers replies that Bluesky drops
      from a thread entirely rather than marking as blocked. This needs an
      external index (constellation.microcosm.blue) to find them, so it is
      opt-in rather than automatic.
    - Debug logging — prints what was restored to the developer console.

    OPEN SOURCE

    Source, tests, and build under MIT at:
    https://github.com/pedropaulovc/bsky-not-blocked

    It runs only on bsky.app.

---

## Single-purpose statement (Chrome Web Store, required)

    The extension has one purpose: to restore Bluesky posts that are hidden from
    the viewer solely because of a block between two accounts other than the
    viewer. Every permission it requests serves that one function.

## Permission justifications (Chrome Web Store, required)

**`storage`**

    Stores the three settings shown in the extension's popup — whether the
    extension is enabled, whether deep recovery is on, and whether debug logging
    is on. Nothing else is stored, and none of it leaves the browser.

**Site access — `https://bsky.app/*`**

The manifest declares no `host_permissions`; the site access comes from the two
content scripts, both matched to `https://bsky.app/*` and nothing else.

    The extension works by reading and repairing the API responses that bsky.app
    itself requests. Its content scripts must run on bsky.app to do that. They
    match no other host, and the extension does nothing on any other site.

**Remote code**

    None. Everything the extension runs ships inside the package; it loads no
    external scripts and evaluates no fetched code.

## Data collection disclosure

Identical answer on all three: **no data collected**, in every category.

- Chrome: tick "I do not collect user data" and all three certification checkboxes.
- Edge: answer "No" to every data-collection question.
- AMO: the manifest already declares this (`data_collection_permissions:
  { required: ["none"] }`), so the dashboard should pre-fill it.

---

## Reviewer notes

Worth pasting into the "notes for reviewer" field on all three, since a reviewer
who does not know Bluesky's block semantics is likely to read this as a
block-evasion tool and reject it:

    This extension does not circumvent any block that applies to the user.

    Bluesky's API applies block filtering to the relationship between two
    records, not to the records themselves. When account A and account B block
    each other, a post by A quoting B is withheld from *all* viewers, including
    viewers that neither A nor B has blocked. That is a side effect of how the
    filtering is scoped, not a moderation decision aimed at the viewer.

    The extension asks Bluesky's public, unauthenticated API
    (app.bsky.feed.getPosts on public.api.bsky.app) for the specific post the
    page was already trying to display. That endpoint returns the post to anyone,
    with no account and no authentication — the content is public. The extension
    puts it back into the page so the thread reads in full.

    It cannot and does not reveal anything hidden by a block involving the user.
    Posts from accounts the user blocks, or that block the user, are not returned
    by that endpoint for the user, and the extension makes no attempt to reach
    them.

    Source and tests: https://github.com/pedropaulovc/bsky-not-blocked
