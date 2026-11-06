'use strict';
// Regression tests for the compiled plugin main thread (code.js, built from code.ts),
// run in node:vm with a stub `figma` global (including figma.clientStorage).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./helpers');

const CODE = fs.readFileSync(path.join(ROOT, 'code.js'), 'utf8');

// Plain-object copy so deepStrictEqual ignores the vm realm's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

const flush = () => new Promise((resolve) => setImmediate(resolve));

// Loads code.js. `stored` seeds clientStorage; `storageMode` can make reads/writes reject.
// Resolves after the startup promise (settings load) has settled.
async function loadCode({ fileKey, stored, storageMode } = {}) {
  const handlers = {};
  const posted = [];
  const notified = [];
  const shown = [];
  const state = { closed: 0 };
  const storage = new Map();
  if (stored !== undefined) storage.set('settings', stored);
  const writes = [];
  const clientStorage = {
    getAsync(key) {
      if (storageMode === 'read-fails') return Promise.reject(new Error('read failed'));
      return Promise.resolve(storage.get(key));
    },
    setAsync(key, value) {
      if (storageMode === 'write-fails') return Promise.reject(new Error('write failed'));
      writes.push({ key, value });
      storage.set(key, value);
      return Promise.resolve();
    },
  };
  const figma = {
    fileKey,
    currentPage: { selection: [] },
    clientStorage,
    showUI(html, options) {
      shown.push({ html, options });
    },
    ui: {
      postMessage(msg) {
        posted.push(msg);
      },
      onmessage: null,
    },
    on(type, fn) {
      handlers[type] = fn;
    },
    notify(message) {
      notified.push(message);
    },
    closePlugin() {
      state.closed++;
    },
  };
  const context = vm.createContext({ figma, __html__: '<html>stub</html>', console });
  vm.runInContext(CODE, context, { filename: 'code.js' });
  await flush();
  return { figma, posted, notified, shown, state, handlers, storage, writes };
}

const settingsMessages = (ctx) => ctx.posted.filter((m) => m.type === 'settings');
const selectionMessages = (ctx) => ctx.posted.filter((m) => m.type === 'selection');

test('code.js shows the UI and posts the default settings and the initial selection', async () => {
  const ctx = await loadCode();
  assert.equal(ctx.shown.length, 1);
  assert.equal(ctx.shown[0].html, '<html>stub</html>');
  assert.deepEqual(plain(ctx.shown[0].options), { width: 320, height: 360 });
  assert.deepEqual(plain(ctx.posted), [
    { type: 'settings', settings: { send: false, token: '' } },
    { type: 'selection', fileKey: null, nodes: [] },
  ]);
});

test('code.js posts stored settings to the UI before the selection', async () => {
  const ctx = await loadCode({ stored: { send: true, token: 'tok' } });
  assert.deepEqual(plain(ctx.posted[0]), { type: 'settings', settings: { send: true, token: 'tok' } });
  assert.equal(ctx.posted[1].type, 'selection');
});

test('code.js falls back to defaults when stored settings are malformed', async () => {
  for (const stored of [
    'nope',
    null,
    { send: 'yes', token: 'x' },
    { send: true },
    { send: true, token: 'x', extra: 1 },
    [true, 'x'],
  ]) {
    const ctx = await loadCode({ stored });
    assert.deepEqual(plain(settingsMessages(ctx)[0]), {
      type: 'settings',
      settings: { send: false, token: '' },
    }, `stored=${JSON.stringify(stored)}`);
  }
});

test('code.js falls back to defaults when clientStorage.getAsync rejects', async () => {
  const ctx = await loadCode({ storageMode: 'read-fails' });
  assert.deepEqual(plain(settingsMessages(ctx)[0]), { type: 'settings', settings: { send: false, token: '' } });
  assert.equal(selectionMessages(ctx).length, 1);
});

test('code.js passes figma.fileKey through to the UI', async () => {
  const ctx = await loadCode({ fileKey: 'FK123' });
  assert.deepEqual(plain(selectionMessages(ctx)[0]), { type: 'selection', fileKey: 'FK123', nodes: [] });
});

test('code.js posts {id, name, type} for the selection on selectionchange', async () => {
  const ctx = await loadCode({ fileKey: 'FK123' });
  ctx.figma.currentPage.selection = [
    { id: '1:2', name: 'Button', type: 'FRAME', children: [{ id: 'x' }], parent: {} },
    { id: '1:3', name: 'Card', type: 'RECTANGLE', extra: true },
  ];
  ctx.handlers.selectionchange();
  const last = plain(ctx.posted[ctx.posted.length - 1]);
  assert.deepEqual(last, {
    type: 'selection',
    fileKey: 'FK123',
    nodes: [
      { id: '1:2', name: 'Button', type: 'FRAME' },
      { id: '1:3', name: 'Card', type: 'RECTANGLE' },
    ],
  });
});

test('code.js posts an empty node list after the selection is cleared', async () => {
  const ctx = await loadCode();
  ctx.figma.currentPage.selection = [{ id: '1:2', name: 'Button', type: 'FRAME' }];
  ctx.handlers.selectionchange();
  ctx.figma.currentPage.selection = [];
  ctx.handlers.selectionchange();
  assert.deepEqual(plain(ctx.posted[ctx.posted.length - 1].nodes), []);
});

test('code.js: selectionchange before settings are loaded is not posted early', async () => {
  // Settings load is async; a selection change during it must not reach the UI first.
  const handlers = {};
  const posted = [];
  const figma = {
    currentPage: { selection: [] },
    clientStorage: {
      getAsync: () => new Promise((resolve) => setTimeout(() => resolve(undefined), 5)),
      setAsync: () => Promise.resolve(),
    },
    showUI() {},
    ui: { postMessage: (m) => posted.push(m), onmessage: null },
    on: (type, fn) => {
      handlers[type] = fn;
    },
    notify() {},
    closePlugin() {},
  };
  vm.runInContext(CODE, vm.createContext({ figma, __html__: '', console }), { filename: 'code.js' });
  handlers.selectionchange();
  assert.deepEqual(posted, [], 'nothing posted while settings are loading');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(plain(posted.map((m) => m.type)), ['settings', 'selection']);
});

test('code.js: notify message calls figma.notify', async () => {
  const ctx = await loadCode();
  ctx.figma.ui.onmessage({ type: 'notify', message: 'x' });
  assert.deepEqual(ctx.notified, ['x']);
});

test('code.js: close message calls figma.closePlugin', async () => {
  const ctx = await loadCode();
  ctx.figma.ui.onmessage({ type: 'close' });
  assert.equal(ctx.state.closed, 1);
});

test('code.js: save-settings stores {send, token} under the "settings" key', async () => {
  const ctx = await loadCode();
  ctx.figma.ui.onmessage({ type: 'save-settings', settings: { send: true, token: 'abc' } });
  await flush();
  assert.deepEqual(plain(ctx.writes), [{ key: 'settings', value: { send: true, token: 'abc' } }]);
  assert.deepEqual(plain(ctx.storage.get('settings')), { send: true, token: 'abc' });
  assert.deepEqual(ctx.notified, []);
});

test('code.js: saved settings are loaded again on the next start', async () => {
  const first = await loadCode();
  first.figma.ui.onmessage({ type: 'save-settings', settings: { send: true, token: 'persist-me' } });
  await flush();
  const second = await loadCode({ stored: first.storage.get('settings') });
  assert.deepEqual(plain(settingsMessages(second)[0].settings), { send: true, token: 'persist-me' });
});

test('code.js: save-settings with extra keys or wrong types is ignored', async () => {
  const ctx = await loadCode();
  const bad = [
    { type: 'save-settings' },
    { type: 'save-settings', settings: null },
    { type: 'save-settings', settings: 'abc' },
    { type: 'save-settings', settings: { send: 'true', token: 'x' } },
    { type: 'save-settings', settings: { send: true, token: 1 } },
    { type: 'save-settings', settings: { send: true } },
    { type: 'save-settings', settings: { send: true, token: 'x', other: 1 } },
    { type: 'save-settings', settings: [] },
  ];
  for (const msg of bad) {
    ctx.figma.ui.onmessage(msg);
  }
  await flush();
  assert.deepEqual(ctx.writes, []);
});

test('code.js: a failed save reports through figma.notify and does not throw', async () => {
  const ctx = await loadCode({ storageMode: 'write-fails' });
  assert.doesNotThrow(() => ctx.figma.ui.onmessage({ type: 'save-settings', settings: { send: false, token: '' } }));
  await flush();
  assert.deepEqual(ctx.notified, ['Не вдалося зберегти налаштування']);
});

test('code.js ignores garbage messages', async () => {
  const ctx = await loadCode();
  const garbage = [
    undefined,
    null,
    'close',
    42,
    true,
    [],
    ['close'],
    {},
    { type: 'other' },
    { type: 'notify' },
    { type: 'notify', message: 5 },
    { type: 'notify', message: null },
    { message: 'no type' },
    { type: 'CLOSE' },
    { type: 'settings', settings: { send: true, token: 'x' } },
    { type: 'selection', fileKey: 'x', nodes: [] },
  ];
  for (const msg of garbage) {
    assert.doesNotThrow(() => ctx.figma.ui.onmessage(msg), `throws for ${JSON.stringify(msg)}`);
  }
  await flush();
  assert.deepEqual(ctx.notified, []);
  assert.equal(ctx.state.closed, 0);
  assert.deepEqual(ctx.writes, []);
});
