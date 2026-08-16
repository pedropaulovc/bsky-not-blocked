# Publishing

The release pipeline (`.github/workflows/publish.yml`) can only *update* a
listing that already exists. Every store requires a human to make the first
submission, because all three ask for things no API accepts:

- a developer agreement accepted by a named person,
- identity/publisher details,
- and, for Chrome, a one-time **5 USD** registration fee.

So publishing is two phases: a one-time manual setup per store, then automated
releases forever after.

Once a store's secrets are set, tagging a release ships to it. Until then that
store's job skips itself and says which secrets are missing — a tag with no
credentials configured anywhere still builds, checksums, and attaches both zips
to a GitHub Release.

---

## Phase 1 — one-time setup

### Before any store

`npm run store:screenshots` writes before/after pairs to `store/screenshots/` at
both sizes the stores accept (1280x800 for Chrome/AMO, 1366x768 for Edge). The
"before" shot shows the grey **Blocked** placeholder and the "after" shot shows
the restored post; submit them as a pair, since a lone "after" shot just looks
like ordinary Bluesky.

They are generated rather than committed (see `.gitignore`). They are shots of
real threads, so they name two real accounts and show that those accounts block
each other. Submitting that to a store listing is a deliberate choice worth
making consciously — if you would rather not, point `test/scenarios.mjs` at your
own test accounts and regenerate.

All listing text — name, summary, description, single-purpose statement,
permission justifications, and reviewer notes — is in [`LISTING.md`](LISTING.md).

> **Read the reviewer notes in `LISTING.md` before submitting.** A reviewer who
> does not know Bluesky's block semantics can read this extension as a
> block-evasion tool, which would be a misreading — it restores only posts
> already public to the viewer — but it is the likeliest reason for a rejection,
> and worth pre-empting in the notes field on all three stores.

### Chrome Web Store

1. Register at <https://chrome.google.com/webstore/devconsole> — **5 USD, one
   time**, and accept the developer agreement.
2. Upload `dist/bsky-not-blocked-chrome-<version>.zip`, fill in the listing from
   `LISTING.md`, and submit for review.
3. Note the **item ID** from the dashboard URL → secret `CWS_EXTENSION_ID`.
4. Note the **publisher ID** under *Publisher → Settings* → `CWS_PUBLISHER_ID`.
5. Enable the API and mint an OAuth client, following
   <https://developer.chrome.com/docs/webstore/using-api>:
   - In Google Cloud Console, enable the **Chrome Web Store API**.
   - Create an OAuth client of type **Desktop app** → `CWS_CLIENT_ID`,
     `CWS_CLIENT_SECRET`.
   - Authorise it once for scope `https://www.googleapis.com/auth/chromewebstore`
     and exchange the resulting code for a refresh token → `CWS_REFRESH_TOKEN`.
     The refresh token is long-lived; it does not need renewing per release.

### Firefox Add-ons (AMO)

Free, no fee.

1. Sign in at <https://addons.mozilla.org/developers/> and accept the agreement.
2. Submit `dist/bsky-not-blocked-firefox-<version>.zip` as a **listed** add-on
   and fill in the listing from `LISTING.md`.
3. Generate API credentials at
   <https://addons.mozilla.org/developers/addon/api/key/> →
   `AMO_JWT_ISSUER` (the JWT issuer) and `AMO_JWT_SECRET`.

Note that AMO reviews Manifest V3 extensions by hand, so a submitted version is
not live immediately. Publishing here also removes the temporary-add-on
limitation: a signed, listed add-on installs permanently, where a locally loaded
one is dropped when Firefox restarts.

### Microsoft Edge Add-ons

Free, no fee. Edge accepts the Chrome zip unchanged — the pipeline submits that
same artifact.

1. Register at <https://partner.microsoft.com/dashboard/microsoftedge> and accept
   the agreement.
2. Submit `dist/bsky-not-blocked-chrome-<version>.zip` and fill in the listing
   from `LISTING.md`.
3. Note the **product ID** from the extension's dashboard URL →
   `EDGE_PRODUCT_ID`.
4. Under *Publish API*, create credentials → `EDGE_CLIENT_ID` and `EDGE_API_KEY`.

The pipeline uses the v1.1 API, which authenticates with the API key and client
ID directly. (The older v1 OAuth2 flow was retired on 2024-12-31; if a guide
tells you to fetch an access token from a tenant URL, it predates the change.)

---

## Phase 2 — wiring the secrets

Each store activates independently as its secrets land — there is no need to set
up all three before releasing to one.

```bash
# Chrome Web Store
gh secret set CWS_CLIENT_ID
gh secret set CWS_CLIENT_SECRET
gh secret set CWS_REFRESH_TOKEN
gh secret set CWS_PUBLISHER_ID
gh secret set CWS_EXTENSION_ID

# Firefox Add-ons
gh secret set AMO_JWT_ISSUER
gh secret set AMO_JWT_SECRET

# Microsoft Edge Add-ons
gh secret set EDGE_PRODUCT_ID
gh secret set EDGE_CLIENT_ID
gh secret set EDGE_API_KEY
```

Each command prompts for the value, so nothing is written to shell history.

Check what the pipeline sees without submitting anything:

```bash
gh workflow run publish.yml -f dry_run=true
```

The `preflight` job prints, per store, either `configured` or the exact list of
missing secrets.

---

## Phase 3 — releasing

`package.json` is the single source of truth for the version;
`scripts/build.mjs` stamps it into both manifests. The pipeline fails if the tag
disagrees with it.

```bash
npm version minor          # or patch / major — writes package.json and tags
git push --follow-tags
```

That runs the tests and lint, builds both zips, attaches them with checksums to
a GitHub Release, and submits to each configured store.

Bear in mind that all three stores reject a version number they have already
seen, so a failed submission needs a version bump rather than a re-run of the
same tag.
