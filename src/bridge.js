/*
 * Isolated-world bridge: the only job here is to carry settings from extension
 * storage into the page world, where the interceptor lives. The interceptor
 * starts on the same defaults, so a slow storage read never leaves it disabled.
 */
(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;
  const DEFAULTS = { enabled: true, deepRecovery: false, debug: false };

  function publish(config) {
    window.postMessage({ source: 'bsky-not-blocked', type: 'config', config }, window.location.origin);
  }

  function push() {
    Promise.resolve(api.storage.local.get(DEFAULTS)).then(publish).catch(() => {});
  }

  push();
  api.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') push();
  });
})();
