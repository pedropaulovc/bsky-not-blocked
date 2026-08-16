'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const DEFAULTS = { enabled: true, deepRecovery: false, debug: false };

Promise.resolve(api.storage.local.get(DEFAULTS)).then((config) => {
  for (const key of Object.keys(DEFAULTS)) {
    const input = document.getElementById(key);
    input.checked = Boolean(config[key]);
    input.addEventListener('change', () => api.storage.local.set({ [key]: input.checked }));
  }
  // Until this lands, the boxes show defaults and nothing is wired up. Marks the
  // point where a click actually does something — which the e2e run waits on.
  document.body.dataset.ready = 'true';
});
