/*
 * Deep recovery is the only switch that sends anything to a third party, so it
 * asks Firefox for the `browsingActivity` data permission first. The rule that
 * matters is that a refusal actually stops the feature — a prompt whose answer
 * is ignored is worse than no prompt, because the manifest then advertises a
 * consent step that does not exist.
 *
 * That logic is a handful of branches with no network and no rendering, so it is
 * tested here against the real src/popup.js rather than through a browser. The
 * end-to-end runs cover that the popup loads and writes to storage at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'popup.js');
const KEYS = ['enabled', 'deepRecovery', 'debug'];

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Runs the real popup script against a stub browser.
 *
 * `dataCollection` is what permissions.getAll() reports: an array is how Firefox
 * advertises data_collection support, and its absence is how Chrome looks.
 * `grant` is the user's answer to the prompt.
 */
function loadPopup({ dataCollection = [], grant = true, stored = {}, revokeFails = false } = {}) {
  const inputs = Object.fromEntries(KEYS.map((key) => [key, { checked: false, listeners: [] }]));
  for (const input of Object.values(inputs)) {
    input.addEventListener = (type, handler) => type === 'change' && input.listeners.push(handler);
  }

  const storage = { ...stored };
  const calls = { requested: 0, removed: 0, writes: [] };
  const body = { dataset: {} };

  const sandbox = {
    console,
    setTimeout,
    Promise,
    Array,
    Object,
    Boolean,
    document: {
      body,
      getElementById: (id) => inputs[id],
    },
    browser: {
      storage: {
        local: {
          get: async (defaults) => ({ ...defaults, ...storage }),
          set: async (patch) => {
            // Copied into this realm: an object built inside the vm has that
            // context's Object.prototype, which deepEqual treats as unequal.
            calls.writes.push({ ...patch });
            Object.assign(storage, patch);
          },
        },
      },
      permissions: {
        getAll: async () => (dataCollection ? { permissions: [], origins: [], data_collection: dataCollection } : { permissions: [], origins: [] }),
        request: async () => {
          calls.requested += 1;
          return grant;
        },
        remove: async () => {
          calls.removed += 1;
          if (revokeFails) throw new Error('revocation refused');
          return true;
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), sandbox, { filename: 'src/popup.js' });

  return {
    calls,
    storage,
    body,
    /** Clicks a switch: sets its state, then fires the handler the popup attached. */
    async toggle(key, checked) {
      inputs[key].checked = checked;
      for (const handler of inputs[key].listeners) await handler();
      await flush();
    },
    checked: (key) => inputs[key].checked,
    async ready() {
      for (let i = 0; i < 10 && body.dataset.ready !== 'true'; i += 1) await flush();
      assert.equal(body.dataset.ready, 'true', 'popup never finished wiring up');
    },
  };
}

test('enabling deep recovery asks for the data permission before storing it', async () => {
  const popup = loadPopup({ dataCollection: [], grant: true });
  await popup.ready();

  await popup.toggle('deepRecovery', true);

  assert.equal(popup.calls.requested, 1, 'must ask before transmitting anything');
  assert.deepEqual(popup.calls.writes, [{ deepRecovery: true }]);
});

test('declining leaves the feature off and writes nothing', async () => {
  // The whole point of the prompt: a refusal has to stop the feature, not be
  // recorded and ignored.
  const popup = loadPopup({ dataCollection: [], grant: false });
  await popup.ready();

  await popup.toggle('deepRecovery', true);

  assert.equal(popup.calls.requested, 1);
  assert.deepEqual(popup.calls.writes, [], 'a declined permission must not be stored as enabled');
  assert.equal(popup.checked('deepRecovery'), false, 'the switch must spring back');
  assert.equal(popup.storage.deepRecovery, undefined);
});

test('switching deep recovery off hands the permission back', async () => {
  const popup = loadPopup({ dataCollection: ['browsingActivity'], stored: { deepRecovery: true } });
  await popup.ready();

  await popup.toggle('deepRecovery', false);

  assert.equal(popup.calls.removed, 1, 'keeps the browser permissions tab honest');
  assert.equal(popup.calls.requested, 0);
  assert.deepEqual(popup.calls.writes, [{ deepRecovery: false }]);
});

test('a browser that refuses to revoke still turns the feature off', async () => {
  // Giving the permission back is best-effort. A browser that will not revoke is
  // no reason to keep transmitting, so the switch must still go off.
  const popup = loadPopup({ dataCollection: ['browsingActivity'], stored: { deepRecovery: true }, revokeFails: true });
  await popup.ready();

  await popup.toggle('deepRecovery', false);

  assert.equal(popup.calls.removed, 1, 'it still tries');
  assert.deepEqual(popup.calls.writes, [{ deepRecovery: false }], 'and switches off regardless');
});

test('the other switches never trigger a permission prompt', async () => {
  const popup = loadPopup({ dataCollection: [] });
  await popup.ready();

  await popup.toggle('enabled', false);
  await popup.toggle('debug', true);

  assert.equal(popup.calls.requested, 0, 'only deep recovery transmits anything');
  assert.equal(popup.calls.removed, 0);
  assert.deepEqual(popup.calls.writes, [{ enabled: false }, { debug: true }]);
});

test('on Chrome the flow is skipped entirely rather than throwing', async () => {
  // Chrome has no data_collection permissions and rejects the key outright, so
  // the switch must still work there.
  const popup = loadPopup({ dataCollection: null });
  await popup.ready();

  await popup.toggle('deepRecovery', true);

  assert.equal(popup.calls.requested, 0, 'must not pass data_collection to a browser without it');
  assert.deepEqual(popup.calls.writes, [{ deepRecovery: true }]);
});

test('the popup restores stored settings into the switches', async () => {
  const popup = loadPopup({ stored: { enabled: false, deepRecovery: true, debug: true } });
  await popup.ready();

  assert.equal(popup.checked('enabled'), false);
  assert.equal(popup.checked('deepRecovery'), true);
  assert.equal(popup.checked('debug'), true);
});
