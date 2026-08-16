'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const DEFAULTS = { enabled: true, deepRecovery: false, debug: false };

/*
 * Deep recovery is the only setting that sends anything anywhere but Bluesky. To
 * find replies the AppView drops from a thread it asks constellation.microcosm.blue
 * which records point at the post being viewed, which means handing that post's
 * URI to a third party. Firefox classifies that as `browsingActivity`; the
 * manifest declares it `optional` and it is asked for here, at the moment the
 * user reaches for the switch, where the prompt has some context.
 *
 * A refusal has to actually stop the feature, or the prompt is theatre — so the
 * switch springs back and nothing reaches storage. Turning it off hands the
 * permission back, which keeps Firefox's Permissions and Data tab honest.
 */
const BROWSING_ACTIVITY = { data_collection: ['browsingActivity'] };

/*
 * Chrome has no data_collection permissions and rejects the key outright, so this
 * flow is Firefox-only. Firefox advertises support by returning the array from
 * getAll(), which is checked once at load rather than per click: request() must be
 * reached straight from the change handler, and awaiting anything first spends the
 * user gesture it requires.
 */
let consentAvailable = false;

function consentFor(key, wanted) {
  if (key !== 'deepRecovery' || !consentAvailable) return Promise.resolve(true);

  // Giving it back is best-effort — a browser that will not revoke is no reason
  // to refuse to switch the feature off.
  if (!wanted) return Promise.resolve(api.permissions.remove(BROWSING_ACTIVITY)).then(() => true, () => true);

  return Promise.resolve(api.permissions.request(BROWSING_ACTIVITY)).then((granted) => granted === true, () => false);
}

Promise.all([
  Promise.resolve(api.storage.local.get(DEFAULTS)),
  Promise.resolve(api.permissions.getAll()).catch(() => ({})),
]).then(([config, granted]) => {
  consentAvailable = Array.isArray(granted.data_collection);

  for (const key of Object.keys(DEFAULTS)) {
    const input = document.getElementById(key);
    input.checked = Boolean(config[key]);

    input.addEventListener('change', () => {
      const wanted = input.checked;
      consentFor(key, wanted).then((allowed) => {
        if (!allowed) {
          input.checked = false;
          return;
        }
        api.storage.local.set({ [key]: wanted });
      });
    });
  }

  // Until this lands, the boxes show defaults and nothing is wired up. Marks the
  // point where a click actually does something — which the e2e run waits on.
  document.body.dataset.ready = 'true';
});
