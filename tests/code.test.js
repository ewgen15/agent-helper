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
// `extra` is merged into the figma stub (variables, styles, node lookup, mixed symbol);
// `clock` replaces the context's Date (to test the time box deterministically).
// Resolves after the startup promise (settings load) has settled.
async function loadCode({ fileKey, stored, storageMode, extra, clock } = {}) {
  const handlers = {};
  const posted = [];
  const notified = [];
  const shown = [];
  const resized = [];
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
      resize(width, height) {
        resized.push({ width, height });
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
    ...extra,
  };
  const sandbox = { figma, __html__: '<html>stub</html>', console };
  if (clock) sandbox.Date = clock;
  const context = vm.createContext(sandbox);
  vm.runInContext(CODE, context, { filename: 'code.js' });
  await flush();
  return { figma, posted, notified, shown, resized, state, handlers, storage, writes, compactTree: context.compactTree, belowOf: context.belowOf };
}

const settingsMessages = (ctx) => ctx.posted.filter((m) => m.type === 'settings');
const selectionMessages = (ctx) => ctx.posted.filter((m) => m.type === 'selection');

test('code.js shows the UI and posts the default settings and the initial selection', async () => {
  const ctx = await loadCode();
  assert.equal(ctx.shown.length, 1);
  assert.equal(ctx.shown[0].html, '<html>stub</html>');
  assert.deepEqual(plain(ctx.shown[0].options), { width: 320, height: 520 });
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

test('code.js: resize with collapsed true resizes the UI to 320x56', async () => {
  const ctx = await loadCode();
  ctx.figma.ui.onmessage({ type: 'resize', collapsed: true });
  assert.deepEqual(ctx.resized, [{ width: 320, height: 56 }]);
});

test('code.js: resize with collapsed false resizes the UI to 320x520', async () => {
  const ctx = await loadCode();
  ctx.figma.ui.onmessage({ type: 'resize', collapsed: false });
  assert.deepEqual(ctx.resized, [{ width: 320, height: 520 }]);
});

test('code.js: resize with a non-boolean or missing collapsed is ignored and does not throw', async () => {
  const ctx = await loadCode();
  const bad = [
    { type: 'resize' },
    { type: 'resize', collapsed: 'true' },
    { type: 'resize', collapsed: 1 },
    { type: 'resize', collapsed: 0 },
    { type: 'resize', collapsed: null },
    { type: 'resize', collapsed: undefined },
    { type: 'resize', collapsed: {} },
  ];
  for (const msg of bad) {
    assert.doesNotThrow(() => ctx.figma.ui.onmessage(msg), `throws for ${JSON.stringify(msg)}`);
  }
  assert.deepEqual(ctx.resized, []);
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

// ---- compactTree (pure; read from the vm context, see PLUGIN_COMPACT_DUMP_SPEC.md §2-§3) ----

const rawNode = (id, name, type, extra = {}) => ({ id, name, type, ...extra });
const rawText = (id, characters, extra = {}) => rawNode(id, 'Cell', 'TEXT', { characters, ...extra });

test('compactTree: empty input gives empty output', async () => {
  const ctx = await loadCode();
  assert.deepEqual(plain(ctx.compactTree([])), { roots: [], budgetUsed: 0, truncated: false });
  assert.deepEqual(plain(ctx.compactTree([], { depth: 6, maxNodes: 300 })), { roots: [], budgetUsed: 0, truncated: false });
});

test('compactTree: a node with no children and no fields is just id, t, n', async () => {
  const ctx = await loadCode();
  const out = plain(ctx.compactTree([rawNode('1:1', 'Empty', 'FRAME')]));
  assert.deepEqual(out.roots, [{ id: '1:1', t: 'FRAME', n: 'Empty' }]);
});

test('compactTree: defaults from spec §2.4 are omitted', async () => {
  const ctx = await loadCode();
  const node = rawNode('1:1', 'Box', 'FRAME', {
    width: 120.4,
    height: 48,
    layout: undefined,
    sizingH: 'FIXED',
    sizingV: 'FIXED',
    opacity: 1,
    radius: 0,
    absolute: false,
    fills: undefined,
    component: undefined,
  });
  const out = plain(ctx.compactTree([node]));
  assert.deepEqual(out.roots, [{ id: '1:1', t: 'FRAME', n: 'Box', w: 120, h: 48 }]);
});

test('compactTree: non-default values are written with spec keys', async () => {
  const ctx = await loadCode();
  const node = rawNode('1:2', 'Panel', 'FRAME', {
    width: 1200,
    height: 336.0000305,
    layout: { mode: 'VERTICAL', padding: [0, 0, 0, 0] },
    sizingH: 'FILL',
    sizingV: 'HUG',
    fills: '$bg/surface/default',
    strokes: '$border/subtle 1',
    radius: 8,
    opacity: 0.499,
    effects: '@Shadow/md',
    absolute: true,
  });
  const out = plain(ctx.compactTree([node]));
  assert.deepEqual(out.roots, [{
    id: '1:2', t: 'FRAME', n: 'Panel', w: 1200, h: 336, L: 'V', sz: 'fill,hug', abs: 1,
    f: '$bg/surface/default', s: '$border/subtle 1', r: 8, o: 0.5, e: '@Shadow/md',
  }]);
});

test('compactTree: layout string follows the §2.2 grammar', async () => {
  const ctx = await loadCode();
  const layout = (value) => plain(ctx.compactTree([rawNode('1:1', 'L', 'FRAME', { layout: value })])).roots[0].L;
  assert.equal(layout({ mode: 'VERTICAL', padding: [0, 80, 80, 80], primaryAlign: 'MIN', counterAlign: 'MIN' }), 'V p0,80,80,80');
  assert.equal(layout({ mode: 'HORIZONTAL', gap: 8, padding: [0, 16, 0, 16], primaryAlign: 'SPACE_BETWEEN', counterAlign: 'CENTER' }), 'H g8 p0,16 aSB,C');
  assert.equal(layout({ mode: 'VERTICAL', gap: '$space/400', padding: [16, 16, 16, 16] }), 'V g$space/400 p16');
  assert.equal(layout({ mode: 'HORIZONTAL', wrap: true, counterGap: 4 }), 'H wrap cg4');
});

test('compactTree: TEXT omits n when name equals characters; instance keeps only changed props', async () => {
  const ctx = await loadCode();
  const text = rawText('2:1', 'Overview', { textStyle: 'Label/S Semibold' });
  const named = rawNode('2:2', 'Overview', 'TEXT', { characters: 'Overview', textStyle: 'Label/S Semibold' });
  const tab = rawNode('61:1022', 'Tabs / Process content', 'INSTANCE', {
    width: 1200,
    height: 48,
    sizingH: 'FILL',
    component: {
      name: 'Tabs',
      variants: { Size: 'M', Type: 'Underline' },
      props: [
        { name: 'Tab count', type: 'TEXT', value: '4', defaultValue: '3' },
        { name: 'Show badge', type: 'BOOLEAN', value: false, defaultValue: false },
      ],
      overrideText: { 'Tab 1/Label': 'Overview' },
      overrideInstances: { 'Tab 2': 'State=Active' },
    },
    children: [rawNode('I1', 'Tab 1', 'INSTANCE'), rawNode('I2', 'Tab 2', 'INSTANCE')],
  });
  const out = plain(ctx.compactTree([text, named, tab]));
  assert.deepEqual(out.roots[0], { id: '2:1', t: 'TEXT', n: 'Cell', tx: 'Overview', ts: 'Label/S Semibold' });
  assert.deepEqual(out.roots[1], { id: '2:2', t: 'TEXT', tx: 'Overview', ts: 'Label/S Semibold' });
  assert.deepEqual(out.roots[2], {
    id: '61:1022', t: 'INSTANCE', n: 'Tabs / Process content', w: 1200, h: 48, sz: 'fill,fixed',
    c: 'Tabs', v: 'Size=M, Type=Underline', p: { 'Tab count': '4' },
    ot: { 'Tab 1/Label': 'Overview' }, oi: { 'Tab 2': 'State=Active' }, cn: 2,
    ch: [{ id: 'I1', t: 'INSTANCE', n: 'Tab 1' }, { id: 'I2', t: 'INSTANCE', n: 'Tab 2' }],
  });
});

test('compactTree: text longer than maxTextChars is cut with an explicit count', async () => {
  const ctx = await loadCode();
  const out = plain(ctx.compactTree([rawText('3:1', 'Upstream process A', {})], { maxTextChars: 8 }));
  assert.equal(out.roots[0].tx, 'Upstream…(+10)');
});

test('compactTree: default depth 2 emits two levels and marks deeper children with cn only', async () => {
  const ctx = await loadCode();
  const tree = rawNode('r', 'Root', 'FRAME', {
    children: [rawNode('m', 'Mid', 'FRAME', {
      children: [rawNode('l', 'Leaf', 'FRAME', { children: [rawNode('d', 'Deep', 'TEXT', { characters: 'x' })] })],
    })],
  });
  const out = plain(ctx.compactTree([tree]));
  assert.deepEqual(out.roots, [{
    id: 'r', t: 'FRAME', n: 'Root',
    ch: [{ id: 'm', t: 'FRAME', n: 'Mid', ch: [{ id: 'l', t: 'FRAME', n: 'Leaf', cn: 1 }] }],
  }]);
  assert.equal(out.budgetUsed, 3);
  assert.equal(out.truncated, false);
});

test('compactTree: an instance lists its children (names, types, real count) without expanding them', async () => {
  const ctx = await loadCode();
  const inst = rawNode('i', 'Button', 'INSTANCE', {
    component: { name: 'Button' },
    children: [rawNode('i1', 'Label', 'TEXT', { characters: 'Save', children: [rawNode('x', 'Deep', 'FRAME')] })],
  });
  const out = plain(ctx.compactTree([inst], { depth: 6 }));
  assert.deepEqual(out.roots, [{
    id: 'i', t: 'INSTANCE', n: 'Button', c: 'Button', cn: 1,
    ch: [{ id: 'i1', t: 'TEXT', n: 'Label', tx: 'Save', cn: 1, ch: [{ id: 'x', t: 'FRAME', n: 'Deep' }] }],
  }]);
});

test('compactTree: an instance listing goes 3 levels deep, then only summarizes what lies below', async () => {
  const ctx = await loadCode();
  // inst -> A -> B -> C (listed); C has a count and a "below" summary instead of children.
  const c = rawNode('C', 'C', 'FRAME', { childCount: 2, below: { count: 3, levels: 2 } });
  const b = rawNode('B', 'B', 'FRAME', { children: [c] });
  const a = rawNode('A', 'A', 'FRAME', { children: [b] });
  const inst = rawNode('i', 'Tabs', 'INSTANCE', { component: { name: 'Tabs' }, children: [a] });
  const out = plain(ctx.compactTree([inst], { depth: 0 }));
  assert.deepEqual(out.roots[0].ch, [{
    id: 'A', t: 'FRAME', n: 'A', cn: 1,
    ch: [{ id: 'B', t: 'FRAME', n: 'B', cn: 1, ch: [{ id: 'C', t: 'FRAME', n: 'C', cn: 2, ch: ['…+3 nodes, ще 2 рівні'] }] }],
  }]);
  assert.equal(out.truncated, true);
});

test('compactTree: expandInstances expands the instance subtree like any other node', async () => {
  const ctx = await loadCode();
  const inst = rawNode('i', 'Button', 'INSTANCE', {
    component: { name: 'Button' },
    children: [rawNode('i1', 'Frame', 'FRAME', { children: [rawNode('i2', 'Leaf', 'FRAME')] })],
  });
  const out = plain(ctx.compactTree([inst], { depth: 2, expandInstances: true }));
  assert.deepEqual(out.roots[0].ch, [{ id: 'i1', t: 'FRAME', n: 'Frame', ch: [{ id: 'i2', t: 'FRAME', n: 'Leaf' }] }]);
});

test('compactTree: a budget cut inside a listing is marked, and so is an unread child', async () => {
  const ctx = await loadCode();
  const kids = ['P', 'Q', 'R'].map((id) => rawNode(id, `Kid ${id}`, 'FRAME'));
  const inst = rawNode('i', 'Tabs', 'INSTANCE', { component: { name: 'Tabs' }, children: kids });
  const cut = plain(ctx.compactTree([inst], { maxNodes: 3 })).roots[0];
  assert.deepEqual(cut.ch, [
    { id: 'P', t: 'FRAME', n: 'Kid P' },
    { id: 'Q', t: 'FRAME', n: 'Kid Q' },
    '…+1 nodes (budget)',
  ]);
  const partial = rawNode('j', 'Tabs', 'INSTANCE', {
    component: { name: 'Tabs' }, childCount: 3, cut: 'timeout', children: [rawNode('P', 'Kid P', 'FRAME')],
  });
  assert.deepEqual(plain(ctx.compactTree([partial])).roots[0].ch, [
    { id: 'P', t: 'FRAME', n: 'Kid P' },
    '…+2 nodes (timeout)',
  ]);
});

test('compactTree: three roots, the first large: roots 2 and 3 keep their first-level children', async () => {
  const ctx = await loadCode();
  const big = rawNode('big', 'Big', 'FRAME', {
    children: Array.from({ length: 200 }, (_, i) => rawNode(`b${i}`, lettersOf(i), 'FRAME')),
  });
  const two = rawNode('two', 'Two', 'FRAME', { children: [rawNode('t1', 'Alpha', 'FRAME'), rawNode('t2', 'Beta', 'FRAME'), rawNode('t3', 'Gamma', 'FRAME')] });
  const three = rawNode('three', 'Three', 'FRAME', { children: [rawNode('h1', 'Delta', 'FRAME'), rawNode('h2', 'Epsilon', 'FRAME')] });
  const out = plain(ctx.compactTree([big, two, three], { maxNodes: 30 }));
  assert.deepEqual(out.roots[1].ch.map((c) => c.id), ['t1', 't2', 't3']);
  assert.deepEqual(out.roots[2].ch.map((c) => c.id), ['h1', 'h2']);
  assert.match(out.roots[0].ch.at(-1), /^…\+\d+ nodes \(budget\)$/);
});

test('compactTree: >= 3 identical consecutive siblings fold into one group with items', async () => {
  const ctx = await loadCode();
  const row = (id, n, text) => rawNode(id, `Row ${n}`, 'FRAME', {
    layout: { mode: 'HORIZONTAL', padding: [0, 16, 0, 16] },
    children: [rawText(`${id}:c`, text, { textStyle: 'Body/S Regular' })],
  });
  const table = rawNode('t', 'Table', 'FRAME', {
    children: [row('r1', 1, 'BR-0012'), row('r2', 2, 'BR-0013'), row('r3', 3, 'BR-0014')],
  });
  const out = plain(ctx.compactTree([table]));
  assert.deepEqual(out.roots[0].ch, [{
    x: 3,
    tpl: {
      t: 'FRAME', n: 'Row #', L: 'H p0,16',
      ch: [{ t: 'TEXT', n: 'Cell', ts: 'Body/S Regular' }],
    },
    items: [
      ['r1', 'BR-0012'],
      ['r2', 'BR-0013'],
      ['r3', 'BR-0014'],
    ],
  }]);
});

test('compactTree: two identical siblings are not folded', async () => {
  const ctx = await loadCode();
  const twins = [rawNode('a', 'Item', 'FRAME'), rawNode('b', 'Item', 'FRAME')];
  const out = plain(ctx.compactTree([rawNode('p', 'Parent', 'FRAME', { children: twins })]));
  assert.deepEqual(out.roots[0].ch, [{ id: 'a', t: 'FRAME', n: 'Item' }, { id: 'b', t: 'FRAME', n: 'Item' }]);
});

test('compactTree: a run is broken by a different sibling, only runs of >= 3 fold', async () => {
  const ctx = await loadCode();
  const item = (id) => rawNode(id, 'Item', 'FRAME');
  const other = rawNode('o', 'Other', 'FRAME');
  const parent = rawNode('p', 'Parent', 'FRAME', {
    children: [item('a'), item('b'), other, item('c'), item('d'), item('e')],
  });
  const out = plain(ctx.compactTree([parent]));
  assert.deepEqual(out.roots[0].ch, [
    { id: 'a', t: 'FRAME', n: 'Item' },
    { id: 'b', t: 'FRAME', n: 'Item' },
    { id: 'o', t: 'FRAME', n: 'Other' },
    { x: 3, tpl: { t: 'FRAME', n: 'Item' }, items: [['c'], ['d'], ['e']] },
  ]);
});

test('compactTree: instances differing only in a TEXT prop fold, differing variants do not', async () => {
  const ctx = await loadCode();
  const tab = (id, label, variant) => rawNode(id, 'Tab', 'INSTANCE', {
    component: {
      name: 'Tab',
      variants: { State: variant },
      props: [{ name: 'Label', type: 'TEXT', value: label, defaultValue: '' }],
    },
  });
  const sameVariant = [tab('1', 'A', 'Default'), tab('2', 'B', 'Default'), tab('3', 'C', 'Default')];
  const out = plain(ctx.compactTree([rawNode('bar', 'Bar', 'FRAME', { children: sameVariant })]));
  assert.equal(out.roots[0].ch.length, 1);
  assert.equal(out.roots[0].ch[0].x, 3);

  const mixed = [tab('1', 'A', 'Default'), tab('2', 'B', 'Active'), tab('3', 'C', 'Default')];
  const out2 = plain(ctx.compactTree([rawNode('bar', 'Bar', 'FRAME', { children: mixed })]));
  assert.equal(out2.roots[0].ch.length, 3);
});

test('compactTree: budget is spent BFS-level, so every level-1 node is kept before level 2', async () => {
  const ctx = await loadCode();
  // Distinct names so nothing folds: each child has two different leaves.
  const branch = (id) => rawNode(id, `Branch ${id}`, 'FRAME', {
    children: [rawNode(`${id}a`, `Leaf ${id}a`, 'FRAME'), rawNode(`${id}b`, `Leaf ${id}b`, 'FRAME')],
  });
  const root = rawNode('R', 'Root', 'FRAME', { children: [branch('A'), branch('B'), branch('C')] });
  // maxNodes 5: root takes 1, level 1 takes 3, one level-2 node is left.
  const out = plain(ctx.compactTree([root], { maxNodes: 5 }));
  assert.equal(out.budgetUsed, 5);
  assert.equal(out.truncated, true);
  assert.deepEqual(out.roots[0].ch, [
    { id: 'A', t: 'FRAME', n: 'Branch A', ch: [{ id: 'Aa', t: 'FRAME', n: 'Leaf Aa' }, '…+1 nodes (budget)'], cn: 2 },
    { id: 'B', t: 'FRAME', n: 'Branch B', cn: 2, ch: ['…+2 nodes (budget)'] },
    { id: 'C', t: 'FRAME', n: 'Branch C', cn: 2, ch: ['…+2 nodes (budget)'] },
  ]);
});

test('compactTree: a budget that covers everything is not truncated', async () => {
  const ctx = await loadCode();
  const root = rawNode('R', 'Root', 'FRAME', { children: [rawNode('a', 'A', 'FRAME'), rawNode('b', 'B', 'FRAME')] });
  const out = plain(ctx.compactTree([root], { maxNodes: 3 }));
  assert.equal(out.truncated, false);
  assert.equal(out.budgetUsed, 3);
  assert.deepEqual(out.roots[0].ch.length, 2);
});

test('compactTree: more than 100 roots keep 100 and add an explicit roots marker', async () => {
  const ctx = await loadCode();
  const roots = Array.from({ length: 120 }, (_, i) => rawNode(`1:${i}`, `F${i}`, 'FRAME'));
  const out = plain(ctx.compactTree(roots));
  assert.equal(out.roots.length, 101);
  assert.equal(out.roots[100], '…+20 roots');
  assert.equal(out.truncated, true);
  assert.equal(out.budgetUsed, 100);
});

test('compactTree: hidden nodes are skipped and not counted in cn or markers', async () => {
  const ctx = await loadCode();
  const root = rawNode('R', 'Root', 'FRAME', {
    children: [
      rawNode('A', 'A', 'FRAME'),
      rawNode('H', 'Hidden', 'FRAME', { visible: false, children: [rawNode('Hc', 'Hc', 'FRAME')] }),
      rawNode('C', 'C', 'FRAME'),
    ],
  });
  const out = plain(ctx.compactTree([root]));
  assert.deepEqual(out.roots[0].ch, [{ id: 'A', t: 'FRAME', n: 'A' }, { id: 'C', t: 'FRAME', n: 'C' }]);
  assert.equal(out.roots[0].cn, undefined);
  assert.equal(out.truncated, false);

  const onlyHidden = rawNode('R2', 'Root2', 'FRAME', { children: [rawNode('H2', 'H2', 'FRAME', { visible: false })] });
  assert.deepEqual(plain(ctx.compactTree([onlyHidden])).roots, [{ id: 'R2', t: 'FRAME', n: 'Root2' }]);

  const hiddenRoot = rawNode('H3', 'Gone', 'FRAME', { visible: false });
  assert.deepEqual(plain(ctx.compactTree([hiddenRoot])), { roots: [], budgetUsed: 0, truncated: false });
});

test('compactTree: include "hidden" keeps hidden nodes and marks them hid', async () => {
  const ctx = await loadCode();
  const root = rawNode('R', 'Root', 'FRAME', {
    children: [rawNode('H', 'H', 'FRAME', { visible: false })],
  });
  const out = plain(ctx.compactTree([root], { include: ['geometry', 'layout', 'paint', 'text', 'instance', 'hidden'] }));
  assert.deepEqual(out.roots[0].ch, [{ id: 'H', t: 'FRAME', n: 'H', hid: 1 }]);
});

test('compactTree: a table of about 40 descendants stays under the 1500-token hard limit', async () => {
  const ctx = await loadCode();
  // 6 rows x 6 distinctly named cells (no folding), each row with its own fill.
  const rows = Array.from({ length: 6 }, (_, r) => rawNode(`row${r}`, `Row ${r}`, 'FRAME', {
    layout: { mode: 'HORIZONTAL', padding: [0, 16, 0, 16] },
    sizingH: 'FILL',
    fills: `$bg/row/${r}`,
    children: Array.from({ length: 6 }, (__, c) => rawNode(`row${r}c${c}`, `Field ${String.fromCharCode(65 + c)}`, 'TEXT', {
      characters: `Value ${r}-${c}`,
      textStyle: 'Body/S Regular',
      sizingH: 'FILL',
    })),
  }));
  const table = rawNode('59:479', 'Process table', 'FRAME', { layout: { mode: 'VERTICAL' }, sizingH: 'FILL', children: rows });
  const out = ctx.compactTree([table]);
  const tokens = Math.ceil(JSON.stringify(plain(out.roots)).length / 4);
  assert.ok(tokens < 1500, `approx tokens ${tokens}`);
  assert.equal(out.truncated, false);
});

// ---- request-detail: collector and message flow (spec §6; plan "Рішення щодо кнопок деталей") ----

const MIXED = Symbol('mixed');
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
};
const solid = (hex, extra = {}) => ({ type: 'SOLID', visible: true, opacity: 1, color: rgb(hex), ...extra });
const alias = (id) => ({ type: 'VARIABLE_ALIAS', id });
// Distinct names that do not end in digits, so siblings do not fold into a group.
const lettersOf = (i) => `Node ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}${String.fromCharCode(65 + Math.floor(i / 676))}`;

// Stub node factories. Children are linked with parent pointers, as instance paths need them.
const node = (id, name, type, extra = {}) => ({ id, name, type, visible: true, parent: null, ...extra });
const frame = (id, name, extra = {}) => node(id, name, 'FRAME', { children: [], ...extra });
const text = (id, characters, extra = {}) => node(id, 'Cell', 'TEXT', { characters, ...extra });
function adopt(parent, children) {
  parent.children = children;
  for (const child of children) child.parent = parent;
  return parent;
}

// Extra figma globals: variable/style/node lookups (async, as in dynamic-page) and the mixed symbol.
function figmaExtras({ nodes = [], variables = {}, styles = {} } = {}) {
  const byId = new Map();
  const index = (n) => {
    byId.set(n.id, n);
    (n.children ?? []).forEach(index);
  };
  nodes.forEach(index);
  const variableNames = new Map(Object.entries(variables));
  const styleNames = new Map(Object.entries(styles));
  return {
    mixed: MIXED,
    variables: { getVariableByIdAsync: async (id) => (variableNames.has(id) ? { name: variableNames.get(id) } : null) },
    getStyleByIdAsync: async (id) => (styleNames.has(id) ? { name: styleNames.get(id) } : null),
    getNodeByIdAsync: async (id) => byId.get(id) ?? null,
  };
}

async function requestDetail(ctx, requestId = 1, message = { type: 'request-detail', requestId }) {
  ctx.figma.ui.onmessage(message);
  await flush();
  await flush();
}
const replies = (ctx) => ctx.posted.filter((m) => m.type === 'detail' || m.type === 'detail-error');

test('request-detail: replies with detail, the echoed requestId and the selection ids', async () => {
  const button = frame('1:2', 'Button', { width: 120.4, height: 48 });
  adopt(button, [text('1:3', 'Save', { name: 'Label' })]);
  const ctx = await loadCode({ extra: figmaExtras({ nodes: [button] }) });
  ctx.figma.currentPage.selection = [button];
  await requestDetail(ctx, 7);
  assert.equal(replies(ctx).length, 1);
  const reply = plain(replies(ctx)[0]);
  assert.equal(reply.type, 'detail');
  assert.equal(reply.requestId, 7);
  assert.deepEqual(reply.ids, ['1:2']);
  assert.equal(reply.detail.v, 1);
  assert.equal(reply.detail.tier, 'B');
  assert.equal(reply.detail.truncated, false);
  assert.deepEqual(reply.detail.roots, [{
    id: '1:2', t: 'FRAME', n: 'Button', w: 120, h: 48,
    ch: [{ id: '1:3', t: 'TEXT', n: 'Label', tx: 'Save' }],
  }]);
});

test('request-detail: ids list every selection root in selection order', async () => {
  const a = frame('1:2', 'A');
  const b = frame('1:3', 'B');
  const ctx = await loadCode({ extra: figmaExtras({ nodes: [a, b] }) });
  ctx.figma.currentPage.selection = [a, b];
  await requestDetail(ctx, 2);
  const reply = plain(replies(ctx)[0]);
  assert.deepEqual(reply.ids, ['1:2', '1:3']);
  assert.deepEqual(reply.detail.roots.map((r) => r.id), ['1:2', '1:3']);
});

test('request-detail: an exception becomes detail-error with the same requestId', async () => {
  const broken = node('9:9', 'Broken', 'INSTANCE', {
    children: [],
    componentProperties: {},
    overrides: [],
    getMainComponentAsync: async () => {
      throw new Error('boom');
    },
  });
  const ctx = await loadCode({ extra: figmaExtras({ nodes: [broken] }) });
  ctx.figma.currentPage.selection = [broken];
  await requestDetail(ctx, 5);
  assert.equal(replies(ctx).length, 1);
  const reply = plain(replies(ctx)[0]);
  assert.equal(reply.type, 'detail-error');
  assert.equal(reply.requestId, 5);
  assert.equal(typeof reply.message, 'string');
  assert.match(reply.message, /boom/);
});

test('request-detail: invalid requestId values are ignored without a reply', async () => {
  const ctx = await loadCode({ extra: figmaExtras() });
  ctx.figma.currentPage.selection = [frame('1:2', 'A')];
  const bad = ['x', NaN, Infinity, -Infinity, null, undefined, {}, [], '7', true];
  for (const requestId of bad) {
    await requestDetail(ctx, requestId, { type: 'request-detail', requestId });
  }
  await requestDetail(ctx, 0, { type: 'request-detail' });
  assert.deepEqual(replies(ctx), []);
  assert.equal(ctx.state.closed, 0);
});

test('request-detail: an empty selection replies detail-error "Нічого не вибрано"', async () => {
  const ctx = await loadCode({ extra: figmaExtras() });
  await requestDetail(ctx, 3);
  assert.deepEqual(plain(replies(ctx)), [{ type: 'detail-error', requestId: 3, message: 'Нічого не вибрано' }]);
});

test('request-detail: selectionchange alone never computes or sends detail', async () => {
  const ctx = await loadCode({ extra: figmaExtras() });
  ctx.figma.currentPage.selection = [frame('1:2', 'A')];
  ctx.posted.length = 0;
  ctx.handlers.selectionchange();
  await flush();
  assert.deepEqual(ctx.posted.map((m) => m.type), ['selection']);
});

test('request-detail: hidden nodes are skipped, and a hidden root is dropped', async () => {
  const root = frame('R', 'Root');
  const hidden = frame('H', 'Hidden', { visible: false });
  adopt(hidden, [frame('Hc', 'Inside')]);
  adopt(root, [frame('A', 'A'), hidden, frame('C', 'C')]);
  const hiddenRoot = frame('HR', 'Gone', { visible: false });
  const ctx = await loadCode({ extra: figmaExtras({ nodes: [root, hiddenRoot] }) });
  ctx.figma.currentPage.selection = [root, hiddenRoot];
  await requestDetail(ctx, 4);
  const reply = plain(replies(ctx)[0]);
  assert.equal(reply.type, 'detail');
  assert.deepEqual(reply.detail.roots, [{
    id: 'R', t: 'FRAME', n: 'Root', ch: [{ id: 'A', t: 'FRAME', n: 'A' }, { id: 'C', t: 'FRAME', n: 'C' }],
  }]);
});

test('request-detail: variables, styles, hex, mixed values and text without a style', async () => {
  const cell = text('T1', 'Overview', {
    name: 'Cell',
    textStyleId: MIXED,
    fontName: MIXED,
    fontSize: MIXED,
    lineHeight: MIXED,
    fills: MIXED,
    getStyledTextSegments: () => [{
      textStyleId: 'S:1',
      fontName: { family: 'Inter', style: 'Semi Bold' },
      fontSize: 14,
      lineHeight: { unit: 'PIXELS', value: 20 },
      fills: [solid('#FF0000')],
    }],
  });
  const price = text('T2', '€10', {
    name: '€10',
    fontName: { family: 'Inter', style: 'Semi Bold' },
    fontSize: 14,
    lineHeight: { unit: 'PIXELS', value: 20 },
    textStyleId: '',
    fills: [solid('#000000')],
  });
  const corners = frame('C', 'Corners', {
    width: 40,
    height: 40,
    cornerRadius: MIXED,
    topLeftRadius: 8,
    topRightRadius: 8,
    bottomRightRadius: 0,
    bottomLeftRadius: 0,
    fills: [solid('#112233', { opacity: 0.5 })],
    strokes: [solid('#D0D5DD')],
    strokeWeight: MIXED,
    strokeTopWeight: 1,
    strokeRightWeight: 0,
    strokeBottomWeight: 1,
    strokeLeftWeight: 0,
  });
  const table = frame('T', 'Table', {
    width: 1200,
    height: 336,
    layoutMode: 'VERTICAL',
    itemSpacing: 8,
    boundVariables: { itemSpacing: alias('V:sp') },
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    primaryAxisAlignItems: 'MIN',
    counterAxisAlignItems: 'MIN',
    layoutSizingHorizontal: 'FILL',
    layoutSizingVertical: 'HUG',
    layoutPositioning: 'AUTO',
    fills: [solid('#FFFFFF', { boundVariables: { color: alias('V:bg') } })],
    strokes: [solid('#D0D5DD')],
    strokeWeight: 1,
    cornerRadius: 8,
    topLeftRadius: 8,
    topRightRadius: 8,
    bottomRightRadius: 8,
    bottomLeftRadius: 8,
    effects: [],
  });
  adopt(table, [cell, price, corners]);
  const ctx = await loadCode({
    extra: figmaExtras({
      nodes: [table],
      variables: { 'V:sp': 'space/400', 'V:bg': 'bg/surface/default' },
      styles: { 'S:1': 'Label/S Semibold' },
    }),
  });
  ctx.figma.currentPage.selection = [table];
  await requestDetail(ctx, 9);
  const reply = plain(replies(ctx)[0]);
  assert.equal(reply.type, 'detail');
  assert.deepEqual(reply.detail.roots, [{
    id: 'T', t: 'FRAME', n: 'Table', w: 1200, h: 336, L: 'V g$space/400', sz: 'fill,hug',
    f: '$bg/surface/default', s: '#D0D5DD! 1', r: 8,
    ch: [
      { id: 'T1', t: 'TEXT', n: 'Cell', tx: 'Overview', ts: 'Label/S Semibold ~mixed', f: '#FF0000! ~mixed' },
      { id: 'T2', t: 'TEXT', tx: '€10', ts: 'Inter 14/20 600', f: '#000000!' },
      { id: 'C', t: 'FRAME', n: 'Corners', w: 40, h: 40, r: '8,8,0,0', f: '#112233/50!', s: '#D0D5DD! 1,0,1,0' },
    ],
  }]);
});

test('request-detail: a component instance reports main component, variants, changed props and overrides', async () => {
  const set = node('S1', 'Tabs', 'COMPONENT_SET', {
    children: [],
    componentPropertyDefinitions: {
      'Tab count#1043:0': { type: 'TEXT', defaultValue: '3' },
      'Show badge#1043:7': { type: 'BOOLEAN', defaultValue: false },
      Size: { type: 'VARIANT', defaultValue: 'S', variantOptions: ['S', 'M'] },
    },
  });
  const main = node('1043:212', 'Size=M, Type=Underline', 'COMPONENT', { parent: set });
  const label = text('I1;L', 'Overview', { name: 'Label' });
  const tab1 = node('I1;T1', 'Tab 1', 'INSTANCE', {
    children: [label],
    componentProperties: {},
    overrides: [],
    getMainComponentAsync: async () => null,
  });
  label.parent = tab1;
  const tab2 = node('I2', 'Tab 2', 'INSTANCE', {
    children: [],
    variantProperties: { State: 'Active' },
    componentProperties: {},
    overrides: [],
    getMainComponentAsync: async () => null,
  });
  const instance = node('61:1022', 'Tabs / Process content', 'INSTANCE', {
    width: 1200,
    height: 48,
    layoutSizingHorizontal: 'FILL',
    layoutSizingVertical: 'FIXED',
    variantProperties: { Size: 'M', Type: 'Underline' },
    componentProperties: {
      Size: { type: 'VARIANT', value: 'M' },
      'Tab count#1043:0': { type: 'TEXT', value: '4' },
      'Show badge#1043:7': { type: 'BOOLEAN', value: false },
    },
    overrides: [
      { id: 'I1;L', overriddenFields: ['characters'] },
      { id: 'I2', overriddenFields: ['componentProperties'] },
    ],
    getMainComponentAsync: async () => main,
  });
  adopt(instance, [tab1, tab2]);
  const ctx = await loadCode({ extra: figmaExtras({ nodes: [instance] }) });
  ctx.figma.currentPage.selection = [instance];
  await requestDetail(ctx, 11);
  const reply = plain(replies(ctx)[0]);
  assert.equal(reply.type, 'detail', reply.message);
  assert.deepEqual(reply.detail.roots, [{
    id: '61:1022', t: 'INSTANCE', n: 'Tabs / Process content', w: 1200, h: 48, sz: 'fill,fixed',
    c: 'Tabs', v: 'Size=M, Type=Underline', p: { 'Tab count': '4' },
    ot: { 'Tab 1/Label': 'Overview' }, oi: { 'Tab 2': 'State=Active' }, cn: 2,
    ch: [
      { id: 'I1;T1', t: 'INSTANCE', n: 'Tab 1', c: 'missing component', cn: 1, ch: [{ id: 'I1;L', t: 'TEXT', n: 'Label', tx: 'Overview' }] },
      { id: 'I2', t: 'INSTANCE', n: 'Tab 2', c: 'missing component' },
    ],
  }]);
});

test('request-detail: a visit cap cut is reported on the root, not silently', async () => {
  const root = frame('R', 'Root');
  adopt(root, Array.from({ length: 1300 }, (_, i) => frame(`c${i}`, lettersOf(i))));
  // Clock stub: time never advances, so only the visit cap can cut.
  const ctx = await loadCode({ extra: figmaExtras({ nodes: [root] }), clock: { now: () => 0 } });
  ctx.figma.currentPage.selection = [root];
  await requestDetail(ctx, 12);
  const detail = plain(replies(ctx)[0]).detail;
  assert.equal(detail.roots[0].ch.length, 61, '59 nodes fit the budget of 60 with the root, then two markers');
  assert.match(detail.roots[0].ch.at(-2), /^…\+\d+ nodes \(budget\)$/);
  assert.equal(detail.roots[0].ch.at(-1), '…+125 nodes (visitCap)');
  assert.equal(detail.roots[1], '…cut roots: R (budget,visitCap)');
  assert.equal(detail.truncated, true);
});

// Each variable lookup costs 1 ms of fake time, so the time share of a root is spent by its reads.
function slowLookupClock(figma) {
  let now = 0;
  figma.variables.getVariableByIdAsync = async () => {
    now += 1;
    return { name: 'bg/x' };
  };
  return { now: () => now };
}

test('request-detail: the 150 ms time box is split per root and reports "timeout" on the cut root', async () => {
  const root = frame('R', 'Root');
  adopt(root, Array.from({ length: 200 }, (_, i) => frame(`c${i}`, lettersOf(i), { fills: [solid('#FFFFFF', { boundVariables: { color: alias(`V${i}`) } })] })));
  const extra = figmaExtras({ nodes: [root] });
  const clock = slowLookupClock(extra);
  const ctx = await loadCode({ extra, clock });
  ctx.figma.currentPage.selection = [root];
  await requestDetail(ctx, 13);
  const detail = plain(replies(ctx)[0]).detail;
  assert.match(detail.roots[0].ch.at(-1), /^…\+\d+ nodes \(timeout\)$/);
  assert.match(detail.roots.at(-1), /^…cut roots: R \(timeout\)$/);
  assert.equal(detail.truncated, true);
});

test('request-detail: three roots, the first large: the time box does not starve roots 2 and 3', async () => {
  const big = frame('B', 'Big');
  adopt(big, Array.from({ length: 200 }, (_, i) => frame(`b${i}`, lettersOf(i), { fills: [solid('#FFFFFF', { boundVariables: { color: alias(`B${i}`) } })] })));
  const two = frame('T', 'Two');
  adopt(two, [1, 2, 3].map((i) => frame(`t${i}`, lettersOf(i), { fills: [solid('#FFFFFF', { boundVariables: { color: alias(`T${i}`) } })] })));
  const three = frame('H', 'Three');
  adopt(three, [1, 2].map((i) => frame(`h${i}`, lettersOf(i), { fills: [solid('#FFFFFF', { boundVariables: { color: alias(`H${i}`) } })] })));
  const extra = figmaExtras({ nodes: [big, two, three] });
  const clock = slowLookupClock(extra);
  const ctx = await loadCode({ extra, clock });
  ctx.figma.currentPage.selection = [big, two, three];
  await requestDetail(ctx, 15);
  const detail = plain(replies(ctx)[0]).detail;
  assert.deepEqual(detail.roots[1].ch.map((c) => c.id), ['t1', 't2', 't3'], 'root 2 keeps its first-level children');
  assert.deepEqual(detail.roots[2].ch.map((c) => c.id), ['h1', 'h2'], 'root 3 keeps its first-level children');
  assert.match(detail.roots[0].ch.at(-1), /^…\+\d+ nodes \(timeout\)$/, 'the large root is the one cut');
});

test('request-detail: a tree over 300 nodes is captured as tier A with explicit node markers', async () => {
  const root = frame('R', 'Root');
  adopt(root, Array.from({ length: 350 }, (_, i) => frame(`c${i}`, lettersOf(i))));
  const ctx = await loadCode({ extra: figmaExtras({ nodes: [root] }) });
  ctx.figma.currentPage.selection = [root];
  await requestDetail(ctx, 14);
  const detail = plain(replies(ctx)[0]).detail;
  assert.equal(detail.tier, 'A');
  assert.equal(detail.maxNodes, 60);
  assert.equal(detail.truncated, true);
  const children = detail.roots[0].ch;
  assert.equal(children.length, 60, 'root plus 59 children fit the budget of 60');
  assert.equal(children[children.length - 1], '…+291 nodes (budget)');
});

test('request-detail: the plugin sets skipInvisibleInstanceChildren on start', async () => {
  const ctx = await loadCode({ extra: figmaExtras() });
  assert.equal(ctx.figma.skipInvisibleInstanceChildren, true);
});

// ---- instance listing, expandInstances and raw paint markers (spec §2.4 rule 3, open question 3) ----

test('request-detail: an instance lists 3 levels, then reports the nodes below as "…+N nodes, ще M рівні"', async () => {
  const inst = node('I', 'Card', 'INSTANCE', {
    width: 100, height: 50, children: [],
    componentProperties: {}, overrides: [], getMainComponentAsync: async () => null,
  });
  // Under the instance: level 1 = X, level 2 = Y, level 3 = Z, then Z -> W -> V (2 levels below Z: W, V).
  const z = frame('Z', 'Z');
  adopt(z, [frame('W', 'W')]);
  z.children[0].children = [frame('V', 'V')];
  z.children[0].children[0].parent = z.children[0];
  const y = frame('Y', 'Y');
  adopt(y, [z]);
  const x = frame('X', 'X');
  adopt(x, [y]);
  adopt(inst, [x]);
  const ctx = await loadCode({ extra: figmaExtras({ nodes: [inst] }) });
  ctx.figma.currentPage.selection = [inst];
  await requestDetail(ctx, 20);
  const reply = plain(replies(ctx)[0]);
  assert.equal(reply.type, 'detail', reply.message);
  const root = reply.detail.roots[0];
  assert.equal(root.cn, 1);
  assert.deepEqual(root.ch, [{
    id: 'X', t: 'FRAME', n: 'X', cn: 1,
    ch: [{
      id: 'Y', t: 'FRAME', n: 'Y', cn: 1,
      ch: [{ id: 'Z', t: 'FRAME', n: 'Z', cn: 1, ch: ['…+2 nodes, ще 2 рівні'] }],
    }],
  }]);
});

// ---- bounded walk below an instance listing (belowOf: iterative, visit budget + time box) ----

test('request-detail: a huge subtree below a listing stops at the visit cap and is marked "≥"', async () => {
  const inst = node('I', 'Table', 'INSTANCE', {
    width: 100, height: 50, children: [],
    componentProperties: {}, overrides: [], getMainComponentAsync: async () => null,
  });
  // inst -> X -> Y -> Z (level 3, listed); Z holds 6000 children, far above the 5000 cap.
  const z = frame('Z', 'Z');
  adopt(z, Array.from({ length: 6000 }, (_, i) => frame(`k${i}`, 'K')));
  const y = frame('Y', 'Y');
  adopt(y, [z]);
  const x = frame('X', 'X');
  adopt(x, [y]);
  adopt(inst, [x]);
  const ctx = await loadCode({ extra: figmaExtras({ nodes: [inst] }) });
  ctx.figma.currentPage.selection = [inst];
  await requestDetail(ctx, 25);
  const reply = plain(replies(ctx)[0]);
  assert.equal(reply.type, 'detail', reply.message);
  const zRec = reply.detail.roots[0].ch[0].ch[0].ch[0];
  assert.equal(zRec.id, 'Z');
  assert.deepEqual(zRec.ch, ['…+≥5000 nodes, ще ≥1 рівень']);
  assert.equal(reply.detail.truncated, true);
});

test('request-detail: once the shared visit budget is spent, a later listed leaf reads "…+? nodes (walk capped)"', async () => {
  const inst = node('I', 'Table', 'INSTANCE', {
    width: 100, height: 50, children: [],
    componentProperties: {}, overrides: [], getMainComponentAsync: async () => null,
  });
  // inst -> X -> [Y1 -> Z1, Y2 -> Z2]; Z1 and Z2 are listed leaves of the same root and share its
  // 5000-node budget. Z1 holds 6000 children and spends the whole budget; Z2 then gets count 0.
  const z1 = frame('Z1', 'Z');
  adopt(z1, Array.from({ length: 6000 }, (_, i) => frame(`k${i}`, 'K')));
  const z2 = adopt(frame('Z2', 'Z'), [frame('q1', 'Q')]);
  const y1 = adopt(frame('Y1', 'Y'), [z1]);
  const y2 = adopt(frame('Y2', 'Y'), [z2]);
  const x = adopt(frame('X', 'X'), [y1, y2]);
  adopt(inst, [x]);
  const ctx = await loadCode({ extra: figmaExtras({ nodes: [inst] }) });
  ctx.figma.currentPage.selection = [inst];
  await requestDetail(ctx, 25);
  const reply = plain(replies(ctx)[0]);
  assert.equal(reply.type, 'detail', reply.message);
  const leaves = reply.detail.roots[0].ch[0].ch.map((y) => y.ch[0]);
  const markers = leaves.map((z) => z.ch[0]).sort();
  assert.deepEqual(markers, ['…+? nodes (walk capped)', '…+≥5000 nodes, ще ≥1 рівень']);
});

test('belowOf: an exhausted shared budget returns count 0 as capped, not as an exact zero', async () => {
  const ctx = await loadCode();
  const top = adopt(frame('t', 'T'), [frame('c', 'C')]);
  assert.deepEqual(plain(ctx.belowOf(top, ['geometry'], { left: 0, sinceCheck: 0, deadline: Infinity })), { count: 0, levels: 0, capped: true });
});

test('belowOf: a deep chain is walked without recursion and stops at the cap as a lower bound', async () => {
  const ctx = await loadCode();
  const top = frame('d0', 'D0');
  let deep = top;
  for (let i = 1; i < 6000; i++) {
    const next = frame(`d${i}`, 'D');
    adopt(deep, [next]);
    deep = next;
  }
  const below = plain(ctx.belowOf(top, ['geometry'], { left: 5000, sinceCheck: 0, deadline: Infinity }));
  assert.deepEqual(below, { count: 5000, levels: 5000, capped: true });
});

test('belowOf: a small subtree is counted exactly and not marked capped, even past the time box', async () => {
  const ctx = await loadCode({ clock: { now: () => 1 } });
  const a = frame('a', 'A');
  adopt(a, [frame('a1', 'A1')]);
  const top = adopt(frame('t', 'T'), [a, frame('b', 'B')]);
  const past = { left: 5000, sinceCheck: 0, deadline: 0 };
  assert.deepEqual(plain(ctx.belowOf(top, ['geometry'], past)), { count: 3, levels: 2 });
  assert.deepEqual(plain(ctx.belowOf(top, ['geometry'], { left: 5000, sinceCheck: 0, deadline: Infinity })), { count: 3, levels: 2 });
});

test('belowOf: the time box is checked periodically with the fake clock and stops the walk', async () => {
  const ctx = await loadCode({ clock: { now: () => 1 } });
  const top = adopt(frame('t', 'T'), Array.from({ length: 3000 }, (_, i) => frame(`c${i}`, 'C')));
  // The deadline (0) has already passed at the first check (after 256 counted nodes).
  const below = plain(ctx.belowOf(top, ['geometry'], { left: 5000, sinceCheck: 0, deadline: 0 }));
  assert.deepEqual(below, { count: 256, levels: 1, capped: true });
});

test('request-detail: expandInstances true expands the instance subtree; other values mean false', async () => {
  const build = () => {
    const inst = node('I', 'Card', 'INSTANCE', {
      width: 10, height: 10, children: [],
      componentProperties: {}, overrides: [], getMainComponentAsync: async () => null,
    });
    const x = frame('X', 'X');
    const leaf = frame('LEAF', 'Leaf');
    adopt(x, [leaf]);
    adopt(inst, [x]);
    return inst;
  };
  // depth 2 default: X at level 1 and Leaf at level 2 both show when expanded.
  const expanded = await loadCode({ extra: figmaExtras({ nodes: [build()] }) });
  const inst1 = build();
  expanded.figma.currentPage.selection = [inst1];
  await requestDetail(expanded, 21, { type: 'request-detail', requestId: 21, expandInstances: true });
  assert.deepEqual(plain(replies(expanded)[0]).detail.roots[0].ch, [{
    id: 'X', t: 'FRAME', n: 'X', ch: [{ id: 'LEAF', t: 'FRAME', n: 'Leaf' }],
  }]);

  for (const flag of ['yes', 1, null, {}]) {
    const ctx = await loadCode({ extra: figmaExtras() });
    const inst = build();
    ctx.figma.currentPage.selection = [inst];
    await requestDetail(ctx, 22, { type: 'request-detail', requestId: 22, expandInstances: flag });
    const reply = plain(replies(ctx)[0]);
    assert.equal(reply.type, 'detail', `flag=${JSON.stringify(flag)}`);
    assert.deepEqual(reply.detail.roots[0].ch, [{ id: 'X', t: 'FRAME', n: 'X', cn: 1, ch: [{ id: 'LEAF', t: 'FRAME', n: 'Leaf' }] }], `flag=${JSON.stringify(flag)}`);
  }
});

test('request-detail: a raw fill and stroke are marked "!", a paint style as @style:<name>, a variable as $name', async () => {
  const box = frame('B', 'Box', {
    fills: [solid('#464749')],
    strokes: [solid('#112233')],
    strokeWeight: 1,
    fillStyleId: 'PS:1',
  });
  const plainBox = frame('P', 'Plain', {
    fills: [solid('#464749')],
    strokes: [solid('#112233', { boundVariables: { color: alias('V:bd') } })],
    strokeWeight: 1,
  });
  const ctx = await loadCode({
    extra: figmaExtras({ nodes: [box, plainBox], variables: { 'V:bd': 'border/subtle' }, styles: { 'PS:1': 'Cytiva Gray/Shade 4·2' } }),
  });
  ctx.figma.currentPage.selection = [box, plainBox];
  await requestDetail(ctx, 23);
  const roots = plain(replies(ctx)[0]).detail.roots;
  assert.equal(roots[0].f, '@style:Cytiva Gray/Shade 4·2');
  assert.equal(roots[0].s, '#112233! 1');
  assert.equal(roots[1].f, '#464749!');
  assert.equal(roots[1].s, '$border/subtle 1');
});
