'use strict';
// Regression tests for the inline <script> in ui.html, run in node:vm with a stub DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./helpers');

const HTML = fs.readFileSync(path.join(ROOT, 'ui.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];

// Objects created inside the vm context have another realm's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeElement(tag) {
  const listeners = {};
  return {
    tagName: tag,
    _text: '',
    // Like a DOM node: reading returns the children's text; assigning replaces the children.
    get textContent() {
      return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
    },
    set textContent(value) {
      this.children = [];
      this._text = String(value);
    },
    className: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    children: [],
    removed: false,
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    dispatch(type, event = {}) {
      (listeners[type] || []).forEach((fn) => fn(event));
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null;
    },
    focus() {},
    setSelectionRange() {},
    select() {},
    remove() {
      this.removed = true;
    },
  };
}

// Builds a fresh DOM/window/navigator/parent stub and runs ui.html's script in it.
// fetchImpl(url, init) stubs the global fetch; the default answers 200 ok.
// A Date for the page in which "now" is nowMs; every other call behaves like the real Date.
function fakeDateAt(nowMs) {
  const RealDate = Date;
  return class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(nowMs);
      else super(...args);
    }
    static now() {
      return nowMs;
    }
  };
}

function loadUi({ clipboard, execCommand, fetchImpl, now } = {}) {
  const elements = {};
  for (const id of ['count', 'list', 'format', 'auto', 'copy', 'status', 'send', 'token', 'health', 'sendStatus',
    'detailBtn', 'comment', 'commentCount', 'expandInstances', 'healthDot',
    'tablist', 'tabSelection', 'tabRecords', 'tabSettings', 'recordsTabLabel', 'panelSelection', 'panelRecords', 'panelSettings',
    'countWrap', 'summary', 'collapseBtn', 'recordsRefresh', 'recordsHint', 'recordsStatus', 'recordsCurrent', 'recordsList', 'recordsSummary',
    'recordView', 'recordBack', 'recordViewBody']) {
    elements[id] = makeElement(id);
  }
  elements.format.value = 'id';

  const docListeners = {};
  const winListeners = {};
  const posted = [];
  const execCalls = [];
  const fetchCalls = [];
  const timers = [];
  const intervals = [];
  const body = makeElement('body');

  const fetch = (url, init) => {
    fetchCalls.push({ url, init });
    if (fetchImpl) return fetchImpl(url, init);
    // Like the server: a detail POST is stored, and the answer counts the selected nodes.
    if (init && init.method === 'POST' && 'detail' in JSON.parse(init.body)) {
      const nodes = JSON.parse(init.body).nodes.length;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, count: nodes, receivedAt: 1, detail: { stored: true, tier: 'compact', nodes } }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, authorized: true }) });
  };
  // Timers are recorded, not run, so tests decide when the 2s timeout fires.
  const fakeSetTimeout = (fn, ms) => {
    timers.push({ fn, ms, cleared: false });
    return timers.length - 1;
  };
  const fakeClearTimeout = (id) => {
    if (timers[id]) timers[id].cleared = true;
  };
  // Intervals are recorded too; tick() runs every interval that is still active.
  const fakeSetInterval = (fn, ms) => {
    intervals.push({ fn, ms, cleared: false });
    return intervals.length - 1;
  };
  const fakeClearInterval = (id) => {
    if (intervals[id]) intervals[id].cleared = true;
  };
  const tick = () => {
    intervals.forEach((iv) => {
      if (!iv.cleared) iv.fn();
    });
  };

  const document = {
    body,
    getElementById: (id) => elements[id] || null,
    createElement: (tag) => makeElement(tag),
    addEventListener(type, fn) {
      (docListeners[type] ||= []).push(fn);
    },
    execCommand(cmd) {
      execCalls.push(cmd);
      return execCommand ? execCommand(cmd) : false;
    },
  };
  const window = {
    addEventListener(type, fn) {
      (winListeners[type] ||= []).push(fn);
    },
  };
  const parent = {
    postMessage(msg, target) {
      posted.push({ msg, target });
    },
  };
  const context = vm.createContext({
    document,
    window,
    navigator: { clipboard },
    parent,
    console,
    fetch,
    AbortController,
    Date: now === undefined ? Date : fakeDateAt(now),
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
  });
  vm.runInContext(SCRIPT, context, { filename: 'ui.html' });

  const sendPlugin = (pluginMessage) => {
    const event = { data: { pluginMessage } };
    (winListeners.message || []).forEach((fn) => fn(event));
  };
  const sendSelection = (fileKey, nodes) => sendPlugin({ type: 'selection', fileKey, nodes });
  const clickDocument = () => (docListeners.click || []).forEach((fn) => fn({}));
  const keyDocument = (event) => (docListeners.keydown || []).forEach((fn) => fn(event));
  const clickCopy = () => elements.copy.dispatch('click', {});

  return {
    elements,
    body,
    posted,
    execCalls,
    fetchCalls,
    timers,
    intervals,
    tick,
    sendPlugin,
    sendSelection,
    clickDocument,
    keyDocument,
    clickCopy,
  };
}

// Enables the send section with a token and returns the UI handle.
function loadSendingUi(options = {}) {
  const ui = loadUi(options);
  ui.elements.send.checked = true;
  ui.elements.token.value = 'secret';
  return ui;
}

function recordingClipboard(resolveWrite = true) {
  const writes = [];
  return {
    writes,
    writeText(text) {
      writes.push(text);
      return resolveWrite ? Promise.resolve() : Promise.reject(new Error('denied'));
    },
  };
}

const NODES = [
  { id: '1:2', name: 'Button', type: 'FRAME' },
  { id: '1:3', name: 'Card', type: 'RECTANGLE' },
];

test('ui.html copy formats', async (t) => {
  const cases = [
    ['id', 'abc', '1:2\n1:3'],
    ['idname', 'abc', '1:2 "Button"\n1:3 "Card"'],
    ['link', 'abc', 'https://www.figma.com/design/abc/?node-id=1-2\nhttps://www.figma.com/design/abc/?node-id=1-3'],
    ['link', null, '1:2\n1:3'],
    ['claude', 'abc', 'Figma nodes:\n1:2 "Button" (FRAME)\n1:3 "Card" (RECTANGLE)'],
  ];
  for (const [format, fileKey, expected] of cases) {
    await t.test(`format=${format} fileKey=${fileKey}`, async () => {
      const clip = recordingClipboard();
      const ui = loadUi({ clipboard: clip });
      ui.elements.format.value = format;
      ui.sendSelection(fileKey, NODES);
      ui.clickCopy();
      await flush();
      assert.deepEqual(clip.writes, [expected]);
      assert.equal(ui.elements.status.textContent, 'Скопійовано');
      assert.deepEqual(plain(ui.posted[0].msg), { pluginMessage: { type: 'notify', message: 'Скопійовано' } });
    });
  }
});

test('ui.html empty selection disables copy and copies nothing', async () => {
  const clip = recordingClipboard();
  const ui = loadUi({ clipboard: clip });
  ui.sendSelection('abc', []);
  assert.equal(ui.elements.copy.disabled, true);
  assert.equal(ui.elements.count.textContent, '0');
  ui.clickCopy();
  await flush();
  assert.deepEqual(clip.writes, []);
  assert.deepEqual(ui.execCalls, []);
});

test('ui.html falls back to execCommand("copy") when clipboard.writeText rejects', async () => {
  const clip = recordingClipboard(false);
  const ui = loadUi({ clipboard: clip, execCommand: () => true });
  ui.sendSelection('abc', NODES);
  ui.clickCopy();
  await flush();
  assert.equal(clip.writes.length, 1);
  assert.deepEqual(ui.execCalls, ['copy']);
  assert.equal(ui.elements.status.textContent, 'Скопійовано');
  // The temporary textarea is removed again.
  const textarea = ui.body.children[0];
  assert.equal(textarea.tagName, 'textarea');
  assert.equal(textarea.value, '1:2\n1:3');
  assert.equal(textarea.removed, true);
});

test('ui.html reports an error when both clipboard and execCommand fail', async () => {
  const ui = loadUi({ clipboard: recordingClipboard(false), execCommand: () => false });
  ui.sendSelection('abc', NODES);
  ui.clickCopy();
  await flush();
  assert.deepEqual(ui.execCalls, ['copy']);
  assert.equal(ui.elements.status.textContent, 'Помилка копіювання');
  assert.equal(ui.elements.status.className, 'status err');
  assert.equal(ui.posted.length, 0);
});

test('ui.html auto-copy fires only after the first click gesture', async () => {
  const clip = recordingClipboard();
  const ui = loadUi({ clipboard: clip });
  ui.elements.auto.checked = true;

  ui.sendSelection('abc', NODES);
  await flush();
  assert.deepEqual(clip.writes, [], 'no auto-copy before any user gesture');

  ui.clickDocument(); // a click anywhere counts as a gesture
  await flush();
  assert.deepEqual(clip.writes, [], 'the gesture itself does not copy');

  ui.sendSelection('abc', [{ id: '9:9', name: 'Other', type: 'TEXT' }]);
  await flush();
  assert.deepEqual(clip.writes, ['9:9']);
});

test('ui.html auto-copy fires only when the selection changes', async () => {
  const clip = recordingClipboard();
  const ui = loadUi({ clipboard: clip });
  ui.elements.auto.checked = true;
  ui.clickDocument();

  ui.sendSelection('abc', NODES);
  await flush();
  assert.equal(clip.writes.length, 1);

  // Same ids again (e.g. selectionchange with no real change): no new copy.
  ui.sendSelection('abc', NODES.map((n) => ({ ...n })));
  await flush();
  assert.equal(clip.writes.length, 1);

  // Different selection: copies again.
  ui.sendSelection('abc', [NODES[0]]);
  await flush();
  assert.equal(clip.writes.length, 2);
  assert.equal(clip.writes[1], '1:2');
});

test('ui.html auto-copy is off unless the checkbox is enabled', async () => {
  const clip = recordingClipboard();
  const ui = loadUi({ clipboard: clip });
  ui.clickDocument();
  ui.sendSelection('abc', NODES);
  await flush();
  assert.deepEqual(clip.writes, []);
});

// ---- Settings persistence (clientStorage round trip through code.ts) ----

test('ui.html applies stored settings from the plugin and loads the list on start', async () => {
  const ui = loadUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  ui.sendPlugin({ type: 'settings', settings: { send: true, token: 'stored-token' } });
  assert.equal(ui.elements.send.checked, true);
  assert.equal(ui.elements.token.value, 'stored-token');
  await flush();
  assert.deepEqual(
    ui.fetchCalls.map((c) => c.url),
    ['http://localhost:3846/health', 'http://localhost:3846/records'],
    'on start: health and the list, never a POST of the selection'
  );
  assert.equal(ui.elements.recordsTabLabel.textContent, 'Записи (1)');
});

test('ui.html ignores malformed settings messages', () => {
  const ui = loadUi();
  ui.sendPlugin({ type: 'settings', settings: { send: 'yes', token: 'x' } });
  ui.sendPlugin({ type: 'settings', settings: { send: true, token: 5 } });
  ui.sendPlugin({ type: 'settings', settings: null });
  ui.sendPlugin({ type: 'settings' });
  assert.equal(ui.elements.send.checked, false);
  assert.equal(ui.elements.token.value, '');
});

test('ui.html saves the checkbox state to the plugin when toggled', () => {
  const ui = loadUi();
  ui.elements.token.value = 'secret';
  ui.elements.send.checked = true;
  ui.elements.send.dispatch('change', {});
  assert.deepEqual(plain(ui.posted[0]), {
    msg: { pluginMessage: { type: 'save-settings', settings: { send: true, token: 'secret', format: 'id' } } },
    target: '*',
  });
});

test('ui.html saves the token to the plugin on each input', () => {
  const ui = loadUi();
  ui.elements.send.checked = false;
  ui.elements.token.value = 'abc';
  ui.elements.token.dispatch('input', {});
  assert.deepEqual(plain(ui.posted[ui.posted.length - 1].msg), {
    pluginMessage: { type: 'save-settings', settings: { send: false, token: 'abc', format: 'id' } },
  });
});

// ---- Sending the selection to the local server ----

test('ui.html sends nothing when the checkbox is disabled', async () => {
  const ui = loadUi();
  ui.elements.token.value = 'secret';
  ui.sendSelection('abc', NODES);
  await flush();
  assert.deepEqual(ui.fetchCalls, []);
  assert.equal(ui.elements.sendStatus.textContent, '');
});

test('ui.html sends nothing when the token is empty or blank', async () => {
  const ui = loadUi();
  ui.elements.send.checked = true;
  ui.sendSelection('abc', NODES);
  ui.elements.token.value = '   ';
  ui.sendSelection('abc', NODES);
  await flush();
  assert.deepEqual(ui.fetchCalls, []);
});

test('ui.html POSTs the selection with the contract URL, headers and body', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  assert.equal(ui.fetchCalls.length, 1);
  const { url, init } = ui.fetchCalls[0];
  assert.equal(url, 'http://localhost:3846/selection');
  assert.equal(init.method, 'POST');
  assert.deepEqual(plain(init.headers), { 'Content-Type': 'application/json', 'x-token': 'secret' });
  assert.deepEqual(JSON.parse(init.body), { fileKey: 'FK1', nodes: NODES });
  assert.equal(ui.elements.sendStatus.textContent, 'Надіслано');
  assert.equal(ui.elements.sendStatus.className, 'status ok');
});

test('ui.html sends an empty selection as nodes: []', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  ui.sendSelection('FK1', []);
  await flush();
  assert.equal(ui.fetchCalls.length, 2);
  assert.deepEqual(JSON.parse(ui.fetchCalls[1].init.body), { fileKey: 'FK1', nodes: [] });
});

test('ui.html sends fileKey null as null', async () => {
  const ui = loadSendingUi();
  ui.sendSelection(null, NODES);
  await flush();
  assert.deepEqual(JSON.parse(ui.fetchCalls[0].init.body), { fileKey: null, nodes: NODES });
});

test('ui.html sends on every selection message, not only on changes', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('abc', NODES);
  ui.sendSelection('abc', NODES.map((n) => ({ ...n })));
  await flush();
  assert.equal(ui.fetchCalls.length, 2);
});

test('ui.html shows an error status when the server answers non-2xx', async () => {
  const ui = loadSendingUi({ fetchImpl: () => Promise.resolve({ ok: false, status: 401 }) });
  ui.sendSelection('abc', NODES);
  await flush();
  assert.equal(ui.elements.sendStatus.textContent, 'Помилка надсилання');
  assert.equal(ui.elements.sendStatus.className, 'status err');
});

test('ui.html fetch rejection shows an error but does not break copy', async () => {
  const clip = recordingClipboard();
  const ui = loadSendingUi({
    clipboard: clip,
    fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
  });
  ui.sendSelection('abc', NODES);
  ui.clickCopy();
  await flush();
  assert.equal(ui.elements.sendStatus.textContent, 'Помилка надсилання');
  assert.equal(ui.elements.status.textContent, 'Скопійовано');
  assert.deepEqual(clip.writes, ['1:2\n1:3']);
});

test('ui.html does not throw when fetch itself throws synchronously', async () => {
  const ui = loadSendingUi({
    fetchImpl: () => {
      throw new Error('boom');
    },
  });
  assert.doesNotThrow(() => ui.sendSelection('abc', NODES));
  await flush();
  assert.equal(ui.elements.sendStatus.textContent, 'Помилка надсилання');
});

test('ui.html aborts the request after 2 seconds', async () => {
  let seenSignal = null;
  const ui = loadSendingUi({
    fetchImpl: (url, init) => {
      seenSignal = init.signal;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  });
  ui.sendSelection('abc', NODES);
  await flush(); // fetch is called after a microtask
  assert.equal(ui.timers.length, 1);
  assert.equal(ui.timers[0].ms, 2000);
  assert.equal(seenSignal.aborted, false);
  ui.timers[0].fn(); // the timeout fires
  assert.equal(seenSignal.aborted, true);
  await flush();
  assert.equal(ui.elements.sendStatus.textContent, 'Помилка надсилання');
});

test('ui.html clears the timeout once the request settles', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('abc', NODES);
  await flush();
  assert.equal(ui.timers[0].cleared, true);
});

test('ui.html ignores a stale response that arrives after a newer one', async () => {
  const resolvers = [];
  const ui = loadSendingUi({
    fetchImpl: () => new Promise((resolve) => resolvers.push(resolve)),
  });
  ui.sendSelection('abc', NODES);
  ui.sendSelection('abc', []);
  await flush();
  resolvers[1]({ ok: true, status: 200 });
  await flush();
  assert.equal(ui.elements.sendStatus.textContent, 'Надіслано');
  resolvers[0]({ ok: false, status: 500 });
  await flush();
  assert.equal(ui.elements.sendStatus.textContent, 'Надіслано', 'older failure does not overwrite');
});

// ---- Server status indicator (GET /health) ----

const HEALTH_URL = 'http://localhost:3846/health';

function healthResponse(body) {
  return () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

function enableSendToggle(ui) {
  ui.elements.send.checked = true;
  ui.elements.send.dispatch('change', {});
}

function healthLine(ui) {
  const el = ui.elements.health;
  return { text: el.textContent, kind: el.className, hidden: el.hidden };
}

test('ui.html makes no requests and shows no indicator while the checkbox is off', async () => {
  const ui = loadUi();
  ui.elements.token.value = 'secret';
  ui.elements.send.dispatch('change', {});
  ui.elements.token.dispatch('input', {});
  await flush();
  ui.tick();
  await flush();
  assert.deepEqual(ui.fetchCalls, []);
  assert.equal(ui.intervals.length, 0, 'no polling by default');
  assert.deepEqual(healthLine(ui), { text: '', kind: 'health', hidden: true });
});

test('ui.html checks /health with x-token on enable, then polls every 3 seconds', async () => {
  const ui = loadUi({ fetchImpl: healthResponse({ ok: true, authorized: true }) });
  ui.elements.token.value = 'secret';
  enableSendToggle(ui);
  await flush();
  assert.equal(ui.fetchCalls.length, 1);
  const { url, init } = ui.fetchCalls[0];
  assert.equal(url, HEALTH_URL);
  assert.equal(init.method, 'GET');
  assert.deepEqual(plain(init.headers), { 'x-token': 'secret' });
  assert.equal(ui.intervals.length, 1);
  assert.equal(ui.intervals[0].ms, 3000);
  ui.tick();
  await flush();
  assert.equal(ui.fetchCalls.length, 2);
});

test('ui.html shows the server states', async (t) => {
  const cases = [
    ['running and authorized', 'secret', healthResponse({ ok: true, authorized: true }), '● Сервер працює', 'health ok'],
    ['running, wrong token', 'secret', healthResponse({ ok: true, authorized: false }), '● Сервер працює, невірний токен', 'health warn'],
    ['running, token empty', '  ', healthResponse({ ok: true, authorized: false }), '● Сервер працює, введіть токен', 'health warn'],
    ['not running', 'secret', () => Promise.reject(new TypeError('Failed to fetch')), '● Сервер не запущений', 'health err'],
  ];
  for (const [name, token, fetchImpl, text, kind] of cases) {
    await t.test(name, async () => {
      const ui = loadUi({ fetchImpl });
      ui.elements.token.value = token;
      enableSendToggle(ui);
      await flush();
      assert.deepEqual(healthLine(ui), { text, kind, hidden: false });
    });
  }
});

test('ui.html treats a hung /health request as not running after 1.5 seconds', async () => {
  const ui = loadUi({
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  ui.elements.token.value = 'secret';
  enableSendToggle(ui);
  await flush();
  const timeout = ui.timers.find((t) => t.ms === 1500 && !t.cleared);
  assert.ok(timeout, 'a 1500 ms timeout is armed');
  timeout.fn();
  await flush();
  assert.equal(healthLine(ui).text, '● Сервер не запущений');
});

test('ui.html stops polling after the checkbox is disabled', async () => {
  const ui = loadUi({ fetchImpl: healthResponse({ ok: true, authorized: true }) });
  ui.elements.token.value = 'secret';
  enableSendToggle(ui);
  await flush();
  ui.tick();
  await flush();
  const before = ui.fetchCalls.length;
  assert.equal(before, 2);

  ui.elements.send.checked = false;
  ui.elements.send.dispatch('change', {});
  assert.equal(ui.intervals[0].cleared, true, 'interval cleared');
  assert.equal(healthLine(ui).hidden, true);
  ui.tick();
  await flush();
  assert.equal(ui.fetchCalls.length, before, 'no requests after disabling');
});

test('ui.html does not throw when the /health fetch rejects or throws synchronously', async () => {
  const rejecting = loadUi({ fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) });
  rejecting.elements.token.value = 'secret';
  assert.doesNotThrow(() => enableSendToggle(rejecting));
  await flush();
  assert.equal(healthLine(rejecting).text, '● Сервер не запущений');

  const throwing = loadUi({ fetchImpl: () => { throw new Error('boom'); } });
  throwing.elements.token.value = 'secret';
  assert.doesNotThrow(() => enableSendToggle(throwing));
  await flush();
  assert.equal(healthLine(throwing).text, '● Сервер не запущений');
});

test('ui.html re-checks health after the token changes, debounced to 400 ms', async () => {
  const ui = loadUi({ fetchImpl: healthResponse({ ok: true, authorized: true }) });
  ui.elements.token.value = 'a';
  enableSendToggle(ui);
  await flush();
  const before = ui.fetchCalls.length;

  ui.elements.token.value = 'ab';
  ui.elements.token.dispatch('input', {});
  ui.elements.token.value = 'abc';
  ui.elements.token.dispatch('input', {});
  await flush();
  assert.equal(ui.fetchCalls.length, before, 'no request while typing');

  // Each input arms a health debounce and a list debounce: [health1, list1, health2, list2].
  const debounced = ui.timers.filter((t) => t.ms === 400);
  assert.equal(debounced.length, 4);
  assert.equal(debounced[0].cleared, true, 'the first health debounce is superseded');
  assert.equal(debounced[1].cleared, true, 'the first list debounce is superseded');
  debounced[2].fn();
  await flush();
  assert.equal(ui.fetchCalls.length, before + 1);
  assert.equal(ui.fetchCalls[before].url, HEALTH_URL);
  assert.deepEqual(plain(ui.fetchCalls[before].init.headers), { 'x-token': 'abc' });
});

test('ui.html POST 401 switches the indicator to the wrong-token state', async () => {
  const ui = loadSendingUi({ fetchImpl: () => Promise.resolve({ ok: false, status: 401 }) });
  ui.sendSelection('abc', NODES);
  await flush();
  assert.equal(ui.elements.sendStatus.textContent, 'Помилка надсилання');
  assert.deepEqual(healthLine(ui), {
    text: '● Сервер працює, невірний токен',
    kind: 'health warn',
    hidden: false,
  });
});

test('ui.html POST network failure switches the indicator to not running', async () => {
  const ui = loadSendingUi({ fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) });
  ui.sendSelection('abc', NODES);
  await flush();
  assert.equal(ui.elements.sendStatus.textContent, 'Помилка надсилання');
  assert.equal(healthLine(ui).text, '● Сервер не запущений');
});

// ---- Detail collection: request-detail → detail reply → POST with detail (+ optional note) ----

const SEND_URL = 'http://localhost:3846/selection';
const DETAIL_TIMEOUT_MS = 5000;
const DETAIL_WAIT = 'Збираю деталі…';
const DETAIL = { format: 'compact-text', nodes: [{ id: '1:2', name: 'Button' }] };
const SAME_IDS = ['1:2', '1:3'];

function bodyOf(call) {
  return JSON.parse(call.init.body);
}

function postCalls(ui) {
  return ui.fetchCalls.filter((c) => c.init && c.init.method === 'POST');
}

function detailRequests(ui) {
  return ui.posted
    .map((p) => p.msg.pluginMessage)
    .filter((m) => m.type === 'request-detail')
    .map((m) => m.requestId);
}

function reply(ui, requestId, ids, detail = DETAIL) {
  ui.sendPlugin({ type: 'detail', requestId, ids, detail });
}

function typeComment(ui, text) {
  ui.elements.comment.value = text;
  ui.elements.comment.dispatch('input', {});
}

function pendingDetailTimer(ui) {
  return ui.timers.find((t) => t.ms === DETAIL_TIMEOUT_MS && !t.cleared);
}

test('ui.html detail buttons are enabled only with sending on, a token and a non-empty selection', () => {
  const ui = loadUi();
  const { detailBtn } = ui.elements;
  const enabled = () => !detailBtn.disabled;

  ui.sendSelection('FK1', NODES);
  assert.equal(enabled(), false, 'sending is off');

  ui.elements.token.value = 'secret';
  ui.elements.token.dispatch('input', {});
  assert.equal(enabled(), false, 'sending still off');

  ui.elements.send.checked = true;
  ui.elements.send.dispatch('change', {});
  assert.equal(enabled(), true, 'sending on, token set, selection non-empty');

  ui.elements.token.value = '   ';
  ui.elements.token.dispatch('input', {});
  assert.equal(enabled(), false, 'blank token');

  ui.elements.token.value = 'secret';
  ui.elements.token.dispatch('input', {});
  ui.sendSelection('FK1', []);
  assert.equal(enabled(), false, 'empty selection');
});

test('ui.html "Відправити деталі" posts request-detail with an incrementing requestId', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();

  ui.elements.detailBtn.dispatch('click', {});
  assert.deepEqual(plain(ui.posted[ui.posted.length - 1]), {
    msg: { pluginMessage: { type: 'request-detail', requestId: 1, expandInstances: false } },
    target: '*',
  });
  assert.equal(ui.elements.sendStatus.textContent, DETAIL_WAIT);

  reply(ui, 1, SAME_IDS);
  await flush();
  ui.elements.detailBtn.dispatch('click', {});
  assert.deepEqual(detailRequests(ui), [1, 2]);
});

test('ui.html disables the detail buttons while a request is in flight', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  const { detailBtn } = ui.elements;

  detailBtn.dispatch('click', {});
  assert.equal(detailBtn.disabled, true);

  reply(ui, 1, SAME_IDS); // the POST is in flight now
  assert.equal(detailBtn.disabled, true);
  await flush();
  assert.equal(detailBtn.disabled, false);
});

test('ui.html sends no request-detail while sending is off, the token is blank or nothing is selected', async () => {
  const ui = loadUi();
  ui.sendSelection('FK1', NODES);
  ui.elements.detailBtn.dispatch('click', {}); // sending off

  ui.elements.token.value = 'secret';
  ui.elements.detailBtn.dispatch('click', {}); // still off

  ui.elements.send.checked = true;
  ui.elements.token.value = '  ';
  ui.elements.detailBtn.dispatch('click', {}); // blank token

  ui.elements.token.value = 'secret';
  ui.sendSelection('FK1', []);
  ui.elements.detailBtn.dispatch('click', {}); // empty selection

  await flush();
  assert.deepEqual(detailRequests(ui), []);
});

test('ui.html matching detail reply POSTs the selection with detail and no note', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  const basic = postCalls(ui).length;

  ui.elements.detailBtn.dispatch('click', {});
  reply(ui, 1, ['1:3', '1:2']); // same set, different order
  await flush();

  const calls = postCalls(ui);
  assert.equal(calls.length, basic + 1);
  const last = calls[calls.length - 1];
  assert.equal(last.url, SEND_URL);
  assert.deepEqual(plain(last.init.headers), { 'Content-Type': 'application/json', 'x-token': 'secret' });
  assert.deepEqual(bodyOf(last), { fileKey: 'FK1', nodes: NODES, detail: DETAIL });
  assert.equal('note' in bodyOf(last), false);
  assert.equal(ui.elements.sendStatus.textContent, 'Деталі збережено (2 вузли)');
  assert.equal(ui.elements.sendStatus.className, 'status ok');
  assert.equal(ui.elements.detailBtn.disabled, false);
});

test('ui.html single detail button posts request-detail and sends the comment as the trimmed note', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  const { comment, commentCount, detailBtn } = ui.elements;

  typeComment(ui, '  Перевір відступи  ');
  assert.equal(commentCount.textContent, '20/2000');

  detailBtn.dispatch('click', {});
  assert.deepEqual(detailRequests(ui), [1]);
  reply(ui, 1, SAME_IDS);
  await flush();

  const calls = postCalls(ui);
  assert.deepEqual(bodyOf(calls[calls.length - 1]), {
    fileKey: 'FK1',
    nodes: NODES,
    detail: DETAIL,
    note: 'Перевір відступи',
  });
  assert.equal(comment.value, '', 'the comment is cleared once it is sent');
});

test('ui.html stale detail replies are ignored: old requestId, mismatched ids, stale errors', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  const basic = postCalls(ui).length;

  ui.elements.detailBtn.dispatch('click', {}); // request 1
  pendingDetailTimer(ui).fn(); // request 1 gives up
  ui.elements.detailBtn.dispatch('click', {}); // request 2 is in flight

  reply(ui, 1, SAME_IDS); // old requestId
  ui.sendPlugin({ type: 'detail-error', requestId: 1, message: 'старе' });
  await flush();
  assert.equal(postCalls(ui).length, basic, 'old reply does not POST');
  assert.equal(ui.elements.sendStatus.textContent, DETAIL_WAIT, 'old error does not show');
  assert.equal(ui.elements.detailBtn.disabled, true, 'request 2 still in flight');

  reply(ui, 2, ['9:9']); // current requestId, other ids
  await flush();
  assert.equal(postCalls(ui).length, basic, 'mismatched ids do not POST');

  reply(ui, 2, SAME_IDS);
  await flush();
  assert.equal(postCalls(ui).length, basic + 1, 'the matching reply POSTs');
});

test('ui.html cancels the pending request when the selection changes; its late reply is ignored', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  const basic = postCalls(ui).length;

  ui.elements.detailBtn.dispatch('click', {});
  ui.sendSelection('FK1', [NODES[0]]);
  assert.equal(ui.elements.detailBtn.disabled, false, 'buttons are usable again');
  assert.notEqual(ui.elements.sendStatus.textContent, DETAIL_WAIT);
  assert.equal(pendingDetailTimer(ui), undefined, 'the timeout is cleared');

  reply(ui, 1, SAME_IDS);
  await flush();
  const calls = postCalls(ui);
  assert.equal(calls.length, basic + 1, 'only the basic selection POST goes out');
  assert.equal('detail' in bodyOf(calls[calls.length - 1]), false);
});

test('ui.html shows a detail-error message in the status line and re-enables the buttons', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  const basic = postCalls(ui).length;

  ui.elements.detailBtn.dispatch('click', {});
  ui.sendPlugin({ type: 'detail-error', requestId: 1, message: 'Виділення занадто велике' });
  assert.equal(ui.elements.sendStatus.textContent, 'Виділення занадто велике');
  assert.equal(ui.elements.sendStatus.className, 'status err');
  assert.equal(ui.elements.detailBtn.disabled, false);
  await flush();
  assert.equal(postCalls(ui).length, basic, 'nothing is POSTed after an error');
});

test('ui.html gives up after 5 seconds with "Таймаут збору деталей"', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  const basic = postCalls(ui).length;

  ui.elements.detailBtn.dispatch('click', {});
  const timer = pendingDetailTimer(ui);
  assert.ok(timer, 'a 5000 ms timeout is armed');
  timer.fn();

  assert.equal(ui.elements.sendStatus.textContent, 'Таймаут збору деталей');
  assert.equal(ui.elements.sendStatus.className, 'status err');
  assert.equal(ui.elements.detailBtn.disabled, false);

  reply(ui, 1, SAME_IDS);
  await flush();
  assert.equal(postCalls(ui).length, basic, 'a reply after the timeout is ignored');
});

test('ui.html clears the comment when the selected ids change, but keeps it for the same ids', () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  const { comment, commentCount } = ui.elements;
  typeComment(ui, 'Тримати');

  ui.sendSelection('FK1', NODES.slice().reverse().map((n) => ({ ...n })));
  assert.equal(comment.value, 'Тримати');

  ui.sendSelection('FK1', [NODES[0]]);
  assert.equal(comment.value, '');
  assert.equal(commentCount.textContent, '0/2000');
});

test('ui.html empty comment sends the detail with no note', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();

  typeComment(ui, '  \n ');
  ui.elements.detailBtn.dispatch('click', {});
  reply(ui, 1, SAME_IDS);
  await flush();

  const calls = postCalls(ui);
  assert.equal('note' in bodyOf(calls[calls.length - 1]), false);
  assert.deepEqual(bodyOf(calls[calls.length - 1]).detail, DETAIL);
});

test('ui.html caps the comment at 2000 characters and sends the capped note', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();

  typeComment(ui, 'я'.repeat(2500));
  assert.equal(ui.elements.comment.value.length, 2000);
  assert.equal(ui.elements.commentCount.textContent, '2000/2000');

  ui.elements.detailBtn.dispatch('click', {});
  reply(ui, 1, SAME_IDS);
  await flush();
  const calls = postCalls(ui);
  assert.equal(bodyOf(calls[calls.length - 1]).note.length, 2000);
});

test('ui.html typing a comment sends nothing by itself (no debounced re-POST)', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  const before = ui.fetchCalls.length;

  typeComment(ui, 'Нотатка');
  typeComment(ui, 'Нотатка ще');
  await flush();

  assert.equal(ui.fetchCalls.length, before, 'no request while typing');
  assert.equal(ui.timers.filter((t) => t.ms === 600).length, 0, 'no debounce timer is armed');
  assert.deepEqual(detailRequests(ui), []);
});

test('ui.html 401 on the detail POST marks the token as wrong and keeps the comment', async () => {
  let posts = 0;
  const ui = loadSendingUi({
    fetchImpl: (url, init) => {
      if (init.method === 'POST') {
        posts += 1;
        return Promise.resolve(posts === 1 ? { ok: true, status: 200 } : { ok: false, status: 401 });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, authorized: true }) });
    },
  });
  ui.sendSelection('FK1', NODES);
  await flush(); // the basic selection POST succeeds

  typeComment(ui, 'Зауваження');
  ui.elements.detailBtn.dispatch('click', {});
  reply(ui, 1, SAME_IDS);
  await flush();

  assert.equal(ui.elements.sendStatus.textContent, 'Помилка надсилання');
  assert.equal(ui.elements.sendStatus.className, 'status err');
  assert.deepEqual(healthLine(ui), {
    text: '● Сервер працює, невірний токен',
    kind: 'health warn',
    hidden: false,
  });
  assert.equal(ui.elements.comment.value, 'Зауваження', 'the comment is kept for a retry');
  assert.equal(ui.elements.detailBtn.disabled, false);
});

// ---- Detail acknowledgement: the server answers 200 even when it rejects the detail ----

const RECORDS_GET_URL = 'http://localhost:3846/records';
const HEALTH_OK = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, authorized: true }) });

// Answers only the detail POST with `answer` (an object becomes the JSON body; 'garbage' is an unparsable body).
// Every other request gets the health-style answer.
function detailAnswer(answer) {
  return (url, init) => {
    if (init.method !== 'POST' || !('detail' in JSON.parse(init.body))) return HEALTH_OK();
    if (answer === 'garbage') {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token')) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
  };
}

function recordsGets(ui) {
  return ui.fetchCalls.filter((c) => c.url === RECORDS_GET_URL && c.init.method === 'GET').length;
}

// Sends a selection, presses "Додати деталі" and answers the request with the given detail reply.
async function detailFlow(ui) {
  ui.sendSelection('FK1', NODES);
  await flush();
  ui.elements.detailBtn.dispatch('click', {});
  reply(ui, 1, SAME_IDS);
  await flush();
}

test('ui.html detail stored:true shows the saved count and refreshes the list', async () => {
  const ui = loadSendingUi({ fetchImpl: detailAnswer({ ok: true, count: 2, receivedAt: 1, detail: { stored: true, tier: 'compact', nodes: 5 } }) });
  await detailFlow(ui);
  assert.equal(ui.elements.sendStatus.textContent, 'Деталі збережено (5 вузлів)');
  assert.equal(ui.elements.sendStatus.className, 'status ok');
  assert.equal(recordsGets(ui), 1, 'the list is fetched once after the stored detail');
});

test('ui.html detail stored:false shows the server error, does not refresh the list', async () => {
  const ui = loadSendingUi({ fetchImpl: detailAnswer({ ok: true, count: 2, receivedAt: 1, detail: { stored: false, error: 'Виділення порожнє' } }) });
  await detailFlow(ui);
  assert.equal(ui.elements.sendStatus.textContent, 'Деталі не збережено: Виділення порожнє');
  assert.equal(ui.elements.sendStatus.className, 'status err');
  assert.equal(recordsGets(ui), 0, 'nothing was saved, so the list is not refetched');
  assert.equal(ui.elements.detailBtn.disabled, false);
});

test('ui.html detail stored:false truncates a long server error to about 120 characters', async () => {
  const longError = 'е'.repeat(400);
  const ui = loadSendingUi({ fetchImpl: detailAnswer({ ok: true, detail: { stored: false, error: longError } }) });
  await detailFlow(ui);
  const text = ui.elements.sendStatus.textContent;
  assert.ok(text.startsWith('Деталі не збережено: е'), 'the prefix and the start of the error are kept');
  assert.ok(text.length <= 'Деталі не збережено: '.length + 120, `too long: ${text.length}`);
  assert.ok(text.endsWith('…'));
  assert.equal(ui.elements.sendStatus.className, 'status err');
});

test('ui.html detail answer without a detail field is an error, not a success', async () => {
  const ui = loadSendingUi({ fetchImpl: detailAnswer({ ok: true, count: 2, receivedAt: 1 }) });
  await detailFlow(ui);
  assert.equal(ui.elements.sendStatus.textContent, 'Сервер не підтвердив збереження деталей');
  assert.equal(ui.elements.sendStatus.className, 'status err');
  assert.equal(recordsGets(ui), 0);
});

test('ui.html detail answer with an unparsable body is a failed request', async () => {
  const ui = loadSendingUi({ fetchImpl: detailAnswer('garbage') });
  await detailFlow(ui);
  assert.equal(ui.elements.sendStatus.textContent, 'Помилка надсилання');
  assert.equal(ui.elements.sendStatus.className, 'status err');
  assert.equal(recordsGets(ui), 0);
  assert.equal(ui.elements.detailBtn.disabled, false);
});

test('ui.html plain selection POST ignores the body and keeps "Надіслано"', async () => {
  const ui = loadSendingUi({ fetchImpl: detailAnswer('garbage') });
  ui.sendSelection('FK1', NODES);
  await flush();
  assert.equal(ui.elements.sendStatus.textContent, 'Надіслано');
  assert.equal(ui.elements.sendStatus.className, 'status ok');
  assert.equal(recordsGets(ui), 0, 'a plain POST does not refetch the list');
});

// ---- "Розгортати інстанси" checkbox (session-only, sent with request-detail) ----

function lastDetailRequest(ui) {
  return ui.posted.map((p) => p.msg.pluginMessage).filter((m) => m.type === 'request-detail').pop();
}

test('ui.html request-detail carries expandInstances false by default', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  assert.equal(ui.elements.expandInstances.checked, false);
  ui.elements.detailBtn.dispatch('click', {});
  assert.deepEqual(plain(lastDetailRequest(ui)), { type: 'request-detail', requestId: 1, expandInstances: false });
});

test('ui.html request-detail carries expandInstances true after the checkbox is checked', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  ui.elements.expandInstances.checked = true;
  ui.elements.detailBtn.dispatch('click', {});
  assert.equal(lastDetailRequest(ui).expandInstances, true);
  reply(ui, 1, SAME_IDS);
  await flush();
  ui.elements.expandInstances.checked = false;
  ui.elements.detailBtn.dispatch('click', {});
  assert.equal(lastDetailRequest(ui).expandInstances, false, 'unchecking applies to the next request');
});

test('ui.html applies expandInstances to a detail request that carries a comment', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  ui.elements.expandInstances.checked = true;
  typeComment(ui, 'Перевір інстанси');
  ui.elements.detailBtn.dispatch('click', {});
  assert.deepEqual(plain(lastDetailRequest(ui)), {
    type: 'request-detail',
    requestId: 1,
    expandInstances: true,
  });
});

test('ui.html does not persist expandInstances (no save-settings message)', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  const before = ui.posted.length;
  ui.elements.expandInstances.checked = true;
  ui.elements.expandInstances.dispatch('change', {});
  ui.elements.detailBtn.dispatch('click', {});
  reply(ui, 1, SAME_IDS);
  await flush();
  const sent = ui.posted.slice(before).map((p) => p.msg.pluginMessage.type);
  assert.equal(sent.includes('save-settings'), false, 'toggling does not save settings');
  assert.deepEqual(sent, ['request-detail'], 'only the request-detail message goes to the plugin');
});

test('ui.html expandInstances checkbox is disabled while a request is in flight and when detail is unavailable', async () => {
  const ui = loadUi();
  const { expandInstances } = ui.elements;
  ui.sendSelection('FK1', NODES);
  assert.equal(expandInstances.disabled, true, 'sending is off');

  ui.elements.send.checked = true;
  ui.elements.send.dispatch('change', {});
  ui.elements.token.value = 'secret';
  ui.elements.token.dispatch('input', {});
  assert.equal(expandInstances.disabled, false, 'sending on, token set, selection non-empty');

  await flush();
  ui.elements.detailBtn.dispatch('click', {});
  assert.equal(expandInstances.disabled, true, 'disabled while the request is pending');

  reply(ui, 1, SAME_IDS); // the POST is in flight now
  assert.equal(expandInstances.disabled, true);
  await flush();
  assert.equal(expandInstances.disabled, false, 're-enabled once the request settles');
});

test('ui.html detail markup: one primary button, an always visible labelled textarea, maxlength 2000', () => {
  assert.match(HTML, /<button id="detailBtn" class="primary" type="button" disabled>Відправити деталі<\/button>/);
  assert.match(HTML, /<div class="comment-box">\s*<div class="comment-head">/, 'the comment box has no hidden attribute');
  assert.match(HTML, /<label for="comment">/);
  assert.match(HTML, /<textarea id="comment"[^>]*maxlength="2000"[^>]*placeholder="Коментар для Claude…"/);
  assert.doesNotMatch(HTML, /commentToggle|commentSend|commentBox|Додати деталі|noteToggle|Написати нотатку/);
});

test('ui.html never persists the comment to the plugin', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();

  typeComment(ui, 'секретна нотатка');
  ui.elements.detailBtn.dispatch('click', {});
  reply(ui, 1, SAME_IDS);
  await flush();

  const calls = postCalls(ui);
  assert.equal(bodyOf(calls[calls.length - 1]).note, 'секретна нотатка', 'the note was sent to the server');
  assert.deepEqual(
    ui.posted.filter((p) => p.msg.pluginMessage.type !== 'request-detail'),
    [],
    'nothing but request-detail reaches the plugin'
  );
});

// ---- Records on the server (GET /records): collapsible list in the send section ----

const RECORDS_URL = 'http://localhost:3846/records';

const RECORD_A = {
  id: 7,
  status: 'new',
  fileKey: 'abcdefghij',
  receivedAt: '2026-11-06T10:20:30.000Z',
  nodeCount: 2,
  nodes: [
    { id: '1:2', name: 'Button', type: 'FRAME' },
    { id: '1:3', name: 'Card', type: 'RECTANGLE' },
  ],
  hasDetail: true,
  note: '<img src=x onerror="alert(1)"> <b>жирно</b>',
};

const RECORD_B = {
  id: 6,
  status: 'new',
  fileKey: null,
  receivedAt: '2026-11-06T09:05:01.000Z',
  nodeCount: 1,
  nodes: [{ id: '2:1', name: 'Title', type: 'TEXT' }],
  hasDetail: false,
};

const RECORD_DONE = {
  id: 5,
  status: 'done',
  fileKey: 'abcdefghij',
  receivedAt: '2026-11-05T08:00:00.000Z',
  nodeCount: 1,
  nodes: [{ id: '3:1', name: 'Done', type: 'FRAME' }],
  hasDetail: false,
};

// Local HH:MM:SS of an ISO time, computed the same way the page does.
function hms(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function recordsResponse(records, current = null) {
  return () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, capacity: 10, records, current }) });
}

const CURRENT_NODES = [
  { id: '5:1', name: 'Hero', type: 'FRAME' },
  { id: '5:2', name: 'Logo', type: 'VECTOR' },
  { id: '5:3', name: 'Caption', type: 'TEXT' },
];

const CURRENT_A = {
  fileKey: 'curfilekey',
  receivedAt: '2026-11-06T12:34:56.000Z',
  empty: false,
  nodeCount: 3,
  nodes: CURRENT_NODES,
};

// Sends /records to recordsImpl; every other URL gets the default health answer.
// A detail POST gets the server's stored answer, so the list is refreshed; anything else gets the health answer.
function withRecords(recordsImpl) {
  return (url, init) => {
    if (url === RECORDS_URL) return recordsImpl(url, init);
    if (init && init.method === 'POST' && 'detail' in JSON.parse(init.body)) {
      return detailAnswer({ ok: true, count: 2, receivedAt: 1, detail: { stored: true, tier: 'compact', nodes: 2 } })(url, init);
    }
    return healthResponse({ ok: true, authorized: true })(url, init);
  };
}

function recordsCalls(ui) {
  return ui.fetchCalls.filter((c) => c.url === RECORDS_URL);
}

function openRecords(ui) {
  ui.elements.tabRecords.dispatch('click', {});
}

function descendants(node, out = []) {
  out.push(node);
  node.children.forEach((c) => descendants(c, out));
  return out;
}

// Elements that carry every class token of cls (a card's badge is "badge badge-new", so "badge" matches it).
function byClass(root, cls) {
  const wanted = cls.split(' ');
  return descendants(root).filter((n) => {
    const have = String(n.className).split(' ');
    return wanted.every((token) => have.includes(token));
  });
}

function recordsStatusLine(ui) {
  return { text: ui.elements.recordsStatus.textContent, kind: ui.elements.recordsStatus.className };
}

test('ui.html records markup: tab label outside the panel, refresh button, live status, no old toggle', () => {
  assert.match(HTML, /<button id="tabRecords"[^>]*><span id="recordsTabLabel">Записи<\/span><\/button>/);
  assert.match(HTML, /<button id="recordsRefresh"[^>]*>Оновити<\/button>/);
  assert.match(HTML, /<div id="recordsStatus"[^>]*aria-live="polite"/);
  const panelAt = HTML.indexOf('id="panelRecords"');
  assert.ok(HTML.indexOf('id="recordsTabLabel"') < panelAt, 'the count label sits in the tab, outside the records panel');
  assert.ok(HTML.indexOf('id="recordsList"') > panelAt, 'the list sits inside the records panel');
  assert.doesNotMatch(HTML, /recordsToggle|recordsBody|recordsLabel/);
  assert.doesNotMatch(SCRIPT, /innerHTML/, 'server data is never put through innerHTML');
});

test('ui.html records makes no request while sending is off or the token is empty', async () => {
  const ui = loadUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  openRecords(ui);
  await flush();
  assert.deepEqual(recordsCalls(ui), []);
  assert.equal(ui.elements.tabRecords.getAttribute('aria-selected'), 'true');
  assert.equal(ui.elements.recordsHint.hidden, false);
  assert.match(HTML, /<div id="recordsHint" class="hint" hidden>Увімкніть надсилання й введіть токен<\/div>/);
  assert.equal(ui.elements.recordsRefresh.disabled, true);

  ui.elements.send.checked = true;
  ui.elements.send.dispatch('change', {});
  ui.elements.token.value = '   ';
  ui.elements.token.dispatch('input', {});
  ui.elements.recordsRefresh.dispatch('click', {});
  await flush();
  assert.deepEqual(recordsCalls(ui), [], 'sending on but a blank token still makes no request');
  assert.equal(ui.elements.recordsHint.hidden, false);
});

test('ui.html records: the tab label starts as "Записи", opening the tab fetches with x-token', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A, RECORD_B])) });
  assert.equal(ui.elements.recordsTabLabel.textContent, 'Записи', 'no number before the first load');
  openRecords(ui);
  await flush();
  const calls = recordsCalls(ui);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(plain(calls[0].init.headers), { 'x-token': 'secret' });
  assert.equal(calls[0].init.body, undefined);
  assert.equal(ui.elements.recordsTabLabel.textContent, 'Записи (2)');
  assert.equal(ui.elements.recordsRefresh.disabled, false);
  assert.equal(ui.elements.recordsList.hidden, false);
  assert.deepEqual(recordsStatusLine(ui), { text: '', kind: 'status' });
  const timeouts = ui.timers.filter((t) => t.ms === 2000);
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].cleared, true, 'the 2 s timeout is cleared once the request settles');

  ui.elements.tabSelection.dispatch('click', {});
  assert.equal(ui.elements.tabSelection.getAttribute('aria-selected'), 'true');
  assert.equal(ui.elements.tabRecords.getAttribute('aria-selected'), 'false');
  assert.equal(ui.elements.panelRecords.hidden, true);
  assert.equal(ui.elements.panelSelection.hidden, false);
  assert.equal(recordsCalls(ui).length, 1, 'leaving the tab does not fetch');
  assert.equal(ui.elements.recordsTabLabel.textContent, 'Записи (2)', 'the count stays visible off-tab');
});

test('ui.html records "Оновити" fetches again', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  openRecords(ui);
  await flush();
  assert.equal(recordsCalls(ui).length, 1);
  ui.elements.recordsRefresh.dispatch('click', {});
  await flush();
  assert.equal(recordsCalls(ui).length, 2);
  assert.deepEqual(plain(recordsCalls(ui)[1].init.headers), { 'x-token': 'secret' });
});

test('ui.html records: a plain selection POST never refetches the list, open or closed', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  ui.sendSelection('FK1', NODES);
  await flush();
  assert.equal(postCalls(ui).length, 1);
  assert.equal(recordsCalls(ui).length, 0, 'closed section: no request after the plain POST');

  openRecords(ui);
  await flush();
  assert.equal(recordsCalls(ui).length, 1, 'opening fetches the list');

  ui.sendSelection('FK1', [NODES[0]]);
  ui.sendSelection('FK1', []);
  await flush();
  assert.equal(postCalls(ui).length, 3);
  assert.equal(recordsCalls(ui).length, 1, 'open section: plain POSTs do not refetch');
});

test('ui.html records: a detail POST refreshes the count even while the tab is closed', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  ui.sendSelection('FK1', NODES);
  await flush();
  ui.elements.detailBtn.dispatch('click', {});
  reply(ui, lastDetailRequest(ui).requestId, SAME_IDS);
  await flush();
  assert.equal(bodyOf(postCalls(ui)[postCalls(ui).length - 1]).detail !== undefined, true, 'the detail POST went out');
  assert.equal(recordsCalls(ui).length, 1, 'the successful detail POST refetches the list');
  assert.equal(ui.elements.recordsTabLabel.textContent, 'Записи (1)');

  openRecords(ui);
  await flush();
  assert.equal(recordsCalls(ui).length, 2, 'opening the tab fetches again');
});

test('ui.html records: a detail POST while open refetches the list', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  ui.sendSelection('FK1', NODES);
  openRecords(ui);
  await flush();
  assert.equal(recordsCalls(ui).length, 1);

  ui.elements.detailBtn.dispatch('click', {});
  reply(ui, lastDetailRequest(ui).requestId, SAME_IDS);
  await flush();
  assert.equal(recordsCalls(ui).length, 2, 'successful detail POST refetches the open list');

  ui.sendSelection('FK1', NODES);
  await flush();
  assert.equal(recordsCalls(ui).length, 2, 'a plain POST in between does not refetch');
});

// ---- Record status: badge, toggle button, count of new records ----

const STATUS_URL = 'http://localhost:3846/records/7/status';

function statusResponse(status, body) {
  return () => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

// Sends /records/<id>/status to statusImpl and /records to recordsImpl; anything else gets the health answer.
function withRecordsAndStatus(recordsImpl, statusImpl) {
  return (url, init) => {
    if (url.endsWith('/status')) return statusImpl(url, init);
    return withRecords(recordsImpl)(url, init);
  };
}

function statusCalls(ui) {
  return ui.fetchCalls.filter((c) => c.url.endsWith('/status'));
}

function statusButton(ui, label) {
  return descendants(ui.elements.recordsList).find((n) => n.tagName === 'button' && n.textContent === label);
}

test('ui.html records: each row shows its status badge and the matching toggle button', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A, RECORD_DONE])) });
  openRecords(ui);
  await flush();
  const rows = ui.elements.recordsList.children;
  assert.equal(rows.length, 2);
  assert.equal(byClass(rows[0], 'badge')[0].textContent, 'нове');
  assert.equal(byClass(rows[1], 'badge')[0].textContent, 'виконано');
  assert.ok(statusButton(ui, 'Позначити виконаним'), 'a new record offers "done"');
  assert.ok(statusButton(ui, 'Повернути в нові'), 'a done record offers "new"');
  assert.equal(rows[0].className, 'rec', 'a new record is not muted');
  assert.equal(rows[1].className, 'rec done', 'a done record is muted');
});

test('ui.html records: the status button POSTs the opposite status with the contract URL, headers and body', async () => {
  const ui = loadSendingUi({
    fetchImpl: withRecordsAndStatus(recordsResponse([RECORD_A]), statusResponse(200, { ok: true, record: { id: 7, status: 'done' } })),
  });
  openRecords(ui);
  await flush();
  statusButton(ui, 'Позначити виконаним').dispatch('click', {});
  await flush();
  assert.equal(statusCalls(ui).length, 1);
  const { url, init } = statusCalls(ui)[0];
  assert.equal(url, STATUS_URL);
  assert.equal(init.method, 'POST');
  assert.deepEqual(plain(init.headers), { 'content-type': 'application/json', 'x-token': 'secret' });
  assert.deepEqual(JSON.parse(init.body), { status: 'done' });
});

test('ui.html records: a done record POSTs "new" back', async () => {
  const ui = loadSendingUi({
    fetchImpl: withRecordsAndStatus(recordsResponse([RECORD_DONE]), statusResponse(200, { ok: true, record: { id: 5, status: 'new' } })),
  });
  openRecords(ui);
  await flush();
  statusButton(ui, 'Повернути в нові').dispatch('click', {});
  await flush();
  assert.equal(statusCalls(ui)[0].url, 'http://localhost:3846/records/5/status');
  assert.deepEqual(JSON.parse(statusCalls(ui)[0].init.body), { status: 'new' });
});

test('ui.html records: the list is fetched again after a successful status change', async () => {
  const ui = loadSendingUi({
    fetchImpl: withRecordsAndStatus(recordsResponse([RECORD_A]), statusResponse(200, { ok: true, record: { id: 7, status: 'done' } })),
  });
  openRecords(ui);
  await flush();
  assert.equal(recordsCalls(ui).length, 1);
  statusButton(ui, 'Позначити виконаним').dispatch('click', {});
  await flush();
  assert.equal(recordsCalls(ui).length, 2, 'refetch after success');
  assert.deepEqual(recordsStatusLine(ui), { text: '', kind: 'status' });
});

test('ui.html records: a 404 on the status POST shows a Ukrainian error and does not refetch', async () => {
  const ui = loadSendingUi({
    fetchImpl: withRecordsAndStatus(recordsResponse([RECORD_A]), statusResponse(404, { ok: false, error: 'not found' })),
  });
  openRecords(ui);
  await flush();
  statusButton(ui, 'Позначити виконаним').dispatch('click', {});
  await flush();
  assert.deepEqual(recordsStatusLine(ui), { text: 'Запис не знайдено', kind: 'status err' });
  assert.equal(recordsCalls(ui).length, 1, 'no refetch on error');
  assert.equal(statusButton(ui, 'Позначити виконаним').disabled, false, 'the button is usable again');
});

test('ui.html records: the tab count and the header count only new records', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A, RECORD_B, RECORD_DONE])) });
  openRecords(ui);
  await flush();
  assert.equal(ui.elements.recordsTabLabel.textContent, 'Записи (2)');
  assert.equal(ui.elements.recordsSummary.textContent, '2 нових з 3');
});

test('ui.html records: a selection POST never triggers a status change or a list refetch', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  openRecords(ui);
  await flush();
  ui.sendSelection('FK1', NODES);
  await flush();
  assert.equal(statusCalls(ui).length, 0);
  assert.equal(recordsCalls(ui).length, 1);
});

test('ui.html records: the current row shows "ще не надходило" when current is null', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A], null)) });
  openRecords(ui);
  await flush();
  const cur = ui.elements.recordsCurrent;
  assert.equal(cur.hidden, false);
  assert.equal(cur.textContent, 'Поточне: ще не надходило');
  assert.equal(byClass(cur, 'rec-cur-label')[0].textContent, 'Поточне');
  assert.equal(descendants(cur).filter((n) => n.tagName === 'button').length, 0, 'no toggle without a selection');
});

test('ui.html records: the current row shows "порожнє" when the selection is empty', async () => {
  const empty = { fileKey: 'curfilekey', receivedAt: CURRENT_A.receivedAt, empty: true, nodeCount: 0, nodes: [] };
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A], empty)) });
  openRecords(ui);
  await flush();
  assert.equal(ui.elements.recordsCurrent.hidden, false);
  assert.equal(ui.elements.recordsCurrent.textContent, 'Поточне: порожнє');
  assert.equal(descendants(ui.elements.recordsCurrent).filter((n) => n.tagName === 'button').length, 0);
});

test('ui.html records: the current row shows time, short file, node count and first node', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A], CURRENT_A)) });
  openRecords(ui);
  await flush();
  const cur = ui.elements.recordsCurrent;
  assert.equal(cur.children[0].textContent, `Поточне: ${hms(CURRENT_A.receivedAt)} · curfil… · 3 вузли · Hero`);
  assert.equal(byClass(cur, 'rec-cur-label')[0].textContent, 'Поточне');
  const toggle = cur.children[0];
  assert.equal(toggle.tagName, 'button');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(cur.children[1].hidden, true, 'nodes start collapsed');
});

test('ui.html records: the current row uses "файл невідомий" and the node plural', async () => {
  const one = { fileKey: null, receivedAt: CURRENT_A.receivedAt, empty: false, nodeCount: 1, nodes: [{ id: '9:9', name: '', type: 'TEXT' }] };
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([], one)) });
  openRecords(ui);
  await flush();
  assert.equal(ui.elements.recordsCurrent.children[0].textContent, `Поточне: ${hms(one.receivedAt)} · файл невідомий · 1 вузол · (без назви)`);
});

test('ui.html records: the current row is not counted in the header N', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A], CURRENT_A)) });
  openRecords(ui);
  await flush();
  assert.equal(ui.elements.recordsTabLabel.textContent, 'Записи (1)');
  assert.equal(ui.elements.recordsList.children.length, 1, 'the current row is not a list row');
});

test('ui.html records: clicking the current row toggles its node list (id · name · type)', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A], CURRENT_A)) });
  openRecords(ui);
  await flush();
  const [toggle, detail] = ui.elements.recordsCurrent.children;
  assert.equal(detail.hidden, true);

  toggle.dispatch('click', {});
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(detail.hidden, false);
  assert.deepEqual(
    byClass(detail, 'rec-node').map((n) => n.textContent),
    ['5:1 · Hero · FRAME', '5:2 · Logo · VECTOR', '5:3 · Caption · TEXT']
  );

  toggle.dispatch('click', {});
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(detail.hidden, true);
});

test('ui.html records: the current row keeps its expansion across a refresh', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A], CURRENT_A)) });
  openRecords(ui);
  await flush();
  ui.elements.recordsCurrent.children[0].dispatch('click', {});
  ui.elements.recordsRefresh.dispatch('click', {});
  await flush();
  assert.equal(ui.elements.recordsCurrent.children[0].getAttribute('aria-expanded'), 'true');
  assert.equal(ui.elements.recordsCurrent.children[1].hidden, false);
});

test('ui.html records: the current row is hidden while sending is off or before the first load', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A], CURRENT_A)) });
  assert.equal(ui.elements.recordsCurrent.hidden, true, 'before any load');
  openRecords(ui);
  await flush();
  assert.equal(ui.elements.recordsCurrent.hidden, false);
  ui.elements.send.checked = false;
  ui.elements.send.dispatch('change', {});
  assert.equal(ui.elements.recordsCurrent.hidden, true, 'sending off hides it');
});

test('ui.html records markup: the current row is a muted line above the list', () => {
  assert.match(HTML, /<div id="recordsCurrent" class="records-current" hidden><\/div>\s*<div id="recordsList"/);
  assert.match(HTML, /\.rec-cur-label \{ color: var\(--muted\)/);
  assert.match(HTML, /\.records-current \{ background: var\(--card-solid\); border: 1px dashed var\(--line\)/);
});

test('ui.html records do not refresh after a failed POST', async () => {
  const ui = loadSendingUi({
    fetchImpl: (url) => (url === RECORDS_URL
      ? recordsResponse([RECORD_A])()
      : Promise.resolve({ ok: false, status: 500 })),
  });
  openRecords(ui);
  await flush();
  ui.sendSelection('FK1', NODES);
  await flush();
  assert.equal(ui.elements.sendStatus.textContent, 'Помилка надсилання');
  assert.equal(recordsCalls(ui).length, 1, 'only the open itself fetched');
});

test('ui.html records refresh after a successful detail POST too', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  ui.sendSelection('FK1', NODES);
  await flush();
  openRecords(ui);
  await flush();
  const before = recordsCalls(ui).length;

  ui.elements.detailBtn.dispatch('click', {});
  reply(ui, lastDetailRequest(ui).requestId, SAME_IDS);
  await flush();
  assert.equal(bodyOf(postCalls(ui)[postCalls(ui).length - 1]).detail !== undefined, true, 'the detail POST went out');
  assert.equal(recordsCalls(ui).length, before + 1);
});

test('ui.html records: turning sending off hides the list and drops a late response', async () => {
  let resolveRecords = null;
  const ui = loadSendingUi({
    fetchImpl: withRecords(() => new Promise((resolve) => { resolveRecords = resolve; })),
  });
  openRecords(ui);
  await flush();
  ui.elements.send.checked = false;
  ui.elements.send.dispatch('change', {});
  assert.equal(ui.elements.recordsHint.hidden, false);
  assert.equal(ui.elements.recordsList.hidden, true);
  assert.equal(ui.elements.recordsRefresh.disabled, true);

  resolveRecords({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, records: [RECORD_A] }) });
  await flush();
  assert.equal(ui.elements.recordsTabLabel.textContent, 'Записи', 'the late response is ignored');
  assert.equal(ui.elements.recordsList.children.length, 0);
});

test('ui.html records token typing refreshes once, debounced to 400 ms', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  openRecords(ui);
  await flush();
  assert.equal(recordsCalls(ui).length, 1);

  ui.elements.token.value = 'secret2';
  ui.elements.token.dispatch('input', {});
  ui.elements.token.value = 'secret3';
  ui.elements.token.dispatch('input', {});
  await flush();
  assert.equal(recordsCalls(ui).length, 1, 'no request while typing');

  // Runs the pending 400 ms timers (the health debounce shares the delay); the superseded record timer is cleared.
  ui.timers.filter((t) => t.ms === 400 && !t.cleared).forEach((t) => t.fn());
  await flush();
  assert.equal(recordsCalls(ui).length, 2);
  assert.deepEqual(plain(recordsCalls(ui)[1].init.headers), { 'x-token': 'secret3' });
});

test('ui.html records shows "Записів ще немає" for an empty list', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([])) });
  openRecords(ui);
  await flush();
  assert.equal(ui.elements.recordsTabLabel.textContent, 'Записи (0)');
  assert.equal(ui.elements.recordsList.children.length, 1);
  assert.equal(ui.elements.recordsList.children[0].textContent, 'Записів ще немає');
});

test('ui.html records error texts: 401, network, other failures', async (t) => {
  const cases = [
    ['401', () => Promise.resolve({ ok: false, status: 401 }), 'Невірний токен'],
    ['network', () => Promise.reject(new TypeError('Failed to fetch')), 'Сервер не запущений'],
    ['500', () => Promise.resolve({ ok: false, status: 500 }), 'Помилка читання записів'],
    ['bad body', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: false }) }), 'Помилка читання записів'],
    ['json throws', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('bad json')) }), 'Помилка читання записів'],
  ];
  for (const [name, impl, text] of cases) {
    await t.test(name, async () => {
      const ui = loadSendingUi({ fetchImpl: withRecords(impl) });
      openRecords(ui);
      await flush();
      assert.deepEqual(recordsStatusLine(ui), { text, kind: 'status err' });
    });
  }
});

test('ui.html records gives up after 2 seconds with "Сервер не запущений"', async () => {
  const ui = loadSendingUi({
    fetchImpl: withRecords((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })),
  });
  openRecords(ui);
  await flush();
  const timeout = ui.timers.find((t) => t.ms === 2000 && !t.cleared);
  assert.ok(timeout, 'a 2000 ms timeout is armed');
  timeout.fn();
  await flush();
  assert.deepEqual(recordsStatusLine(ui), { text: 'Сервер не запущений', kind: 'status err' });
});

// ---- Tabs: "Виділення" and "Записи (N)" ----

test('ui.html tabs markup: tablist with three tabs, each with aria wiring and a matching tabpanel', () => {
  assert.match(HTML, /<div id="tablist" class="tabs" role="tablist"/);
  assert.match(HTML, /<button id="tabSelection" class="tab" type="button" role="tab" aria-selected="true" aria-controls="panelSelection" tabindex="0">Виділення<\/button>/);
  assert.match(HTML, /<button id="tabRecords" class="tab" type="button" role="tab" aria-selected="false" aria-controls="panelRecords" tabindex="-1">/);
  assert.match(HTML, /<button id="tabSettings" class="tab" type="button" role="tab" aria-selected="false" aria-controls="panelSettings" tabindex="-1">Налаштування<\/button>/);
  assert.match(HTML, /<div id="panelSelection" class="panel" role="tabpanel" aria-labelledby="tabSelection">/);
  assert.match(HTML, /<div id="panelRecords" class="panel" role="tabpanel" aria-labelledby="tabRecords" hidden>/);
  assert.match(HTML, /<div id="panelSettings" class="panel" role="tabpanel" aria-labelledby="tabSettings" hidden>/);
});

test('ui.html settings controls live in the settings panel; the selection panel keeps only selection tools', () => {
  const selAt = HTML.indexOf('id="panelSelection"');
  const recAt = HTML.indexOf('id="panelRecords"');
  const setAt = HTML.indexOf('id="panelSettings"');
  const at = (id) => HTML.indexOf(`id="${id}"`);
  for (const id of ['list', 'copy', 'auto', 'expandInstances', 'comment', 'detailBtn', 'sendStatus']) {
    assert.ok(at(id) > selAt && at(id) < recAt, `${id} is in the selection panel`);
  }
  for (const id of ['send', 'format', 'token', 'health']) {
    assert.ok(at(id) > setAt, `${id} is in the settings panel`);
    assert.ok(!(at(id) > selAt && at(id) < recAt), `${id} is not in the selection panel`);
  }
});

test('ui.html tabs: click, arrow keys (wrapping), Home and End switch the panel and aria-selected', () => {
  const ui = loadUi();
  const { tabSelection, tabRecords, tabSettings, panelSelection, panelRecords, panelSettings, tablist } = ui.elements;
  const key = (k) => tablist.dispatch('keydown', { key: k, preventDefault() {} });
  const selected = () => [tabSelection, tabRecords, tabSettings].map((t) => t.getAttribute('aria-selected'));

  tabRecords.dispatch('click', {});
  assert.deepEqual(selected(), ['false', 'true', 'false']);
  assert.equal(tabRecords.tabIndex, 0, 'the selected tab is in the tab order');
  assert.equal(tabSelection.tabIndex, -1);
  assert.equal(panelRecords.hidden, false);
  assert.equal(panelSelection.hidden, true);
  assert.equal(panelSettings.hidden, true);

  key('ArrowRight');
  assert.deepEqual(selected(), ['false', 'false', 'true']);
  assert.equal(panelSettings.hidden, false);
  key('ArrowRight');
  assert.deepEqual(selected(), ['true', 'false', 'false'], 'ArrowRight wraps to the first tab');
  assert.equal(panelSelection.hidden, false);
  key('ArrowLeft');
  assert.deepEqual(selected(), ['false', 'false', 'true'], 'ArrowLeft wraps to the last tab');
  key('ArrowLeft');
  assert.deepEqual(selected(), ['false', 'true', 'false']);
  key('Home');
  assert.deepEqual(selected(), ['true', 'false', 'false']);
  key('End');
  assert.deepEqual(selected(), ['false', 'false', 'true']);
  assert.equal(tabSettings.tabIndex, 0);
  key('a');
  assert.deepEqual(selected(), ['false', 'false', 'true'], 'other keys change nothing');
});

test('ui.html tab label: "Записи" until the count is known, then "Записи (N)" on both tabs', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A, RECORD_B])) });
  assert.equal(ui.elements.recordsTabLabel.textContent, 'Записи');
  ui.elements.tabRecords.dispatch('click', {});
  await flush();
  assert.equal(ui.elements.recordsTabLabel.textContent, 'Записи (2)');
  ui.elements.tabSelection.dispatch('click', {});
  assert.equal(ui.elements.recordsTabLabel.textContent, 'Записи (2)', 'visible while the other tab is active');
});

test('ui.html records: selection-only POSTs never refetch the count, even off-tab', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  ui.sendSelection('FK1', NODES);
  ui.sendSelection('FK1', [NODES[0]]);
  await flush();
  assert.equal(postCalls(ui).length, 2);
  assert.equal(recordsCalls(ui).length, 0, 'plain POSTs do not fetch the list');
});

test('ui.html records: a token edit refreshes the list only while sending is on', async () => {
  const ui = loadUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  ui.elements.token.value = 'secret';
  ui.elements.token.dispatch('input', {});
  ui.timers.filter((t) => t.ms === 400 && !t.cleared).forEach((t) => t.fn());
  await flush();
  assert.equal(recordsCalls(ui).length, 0, 'sending off: no list request');

  ui.elements.send.checked = true;
  ui.elements.send.dispatch('change', {});
  assert.equal(recordsCalls(ui).length, 0, 'enabling sending does not fetch by itself');
  ui.elements.token.value = 'secret2';
  ui.elements.token.dispatch('input', {});
  ui.timers.filter((t) => t.ms === 400 && !t.cleared).forEach((t) => t.fn());
  await flush();
  assert.equal(recordsCalls(ui).length, 1, 'a token edit with sending on refreshes once');
});

// ---- Collapse: header row only, resize message to the plugin ----

test('ui.html collapse markup and CSS: the header stays, body.collapsed hides the content', () => {
  assert.match(HTML, /<button id="collapseBtn"[^>]*aria-expanded="true"[^>]*aria-controls="content"[^>]*>▾ Згорнути<\/button>/);
  assert.match(HTML, /<div id="content" class="content">/);
  assert.match(HTML, /body\.collapsed \.content,\s*body\.collapsed \.tabs \{ display: none; \}/);
});

test('ui.html collapse button posts resize with the boolean and toggles the body class', () => {
  const ui = loadUi();
  const { collapseBtn } = ui.elements;
  collapseBtn.dispatch('click', {});
  assert.deepEqual(plain(ui.posted[ui.posted.length - 1]), {
    msg: { pluginMessage: { type: 'resize', collapsed: true } },
    target: '*',
  });
  assert.equal(ui.body.className, 'collapsed');
  assert.equal(collapseBtn.textContent, '▸ Розгорнути');
  assert.equal(collapseBtn.getAttribute('aria-expanded'), 'false');

  collapseBtn.dispatch('click', {});
  assert.deepEqual(plain(ui.posted[ui.posted.length - 1]).msg, { pluginMessage: { type: 'resize', collapsed: false } });
  assert.equal(ui.body.className, '');
  assert.equal(collapseBtn.textContent, '▾ Згорнути');
  assert.equal(collapseBtn.getAttribute('aria-expanded'), 'true');
  assert.equal(ui.posted.length, 2, 'one resize message per click');
});

test('ui.html collapsed header shows the node count with the Ukrainian plural', () => {
  const ui = loadUi();
  const { summary, countWrap, collapseBtn } = ui.elements;
  ui.sendSelection('FK1', NODES);
  assert.equal(countWrap.hidden, false);
  assert.equal(summary.hidden, true);

  collapseBtn.dispatch('click', {});
  assert.equal(countWrap.hidden, true);
  assert.equal(summary.hidden, false);
  assert.equal(summary.textContent, '2 вузли');

  ui.sendSelection('FK1', [1, 2, 3, 4, 5].map((i) => ({ id: `1:${i}`, name: `N${i}`, type: 'FRAME' })));
  assert.equal(summary.textContent, '5 вузлів');
  ui.sendSelection('FK1', []);
  assert.equal(summary.textContent, 'Нічого не вибрано');
});

test('ui.html keeps auto-copy and sending working while collapsed', async () => {
  const clip = recordingClipboard();
  const ui = loadSendingUi({ clipboard: clip });
  ui.elements.auto.checked = true;
  ui.clickDocument();
  ui.elements.collapseBtn.dispatch('click', {});
  ui.sendSelection('FK1', NODES);
  await flush();
  assert.deepEqual(clip.writes, ['1:2\n1:3'], 'auto-copy still fires');
  assert.equal(postCalls(ui).length, 1, 'the selection is still sent');
});

test('ui.html loads no external resources: only the localhost server URLs and the figma.com link format', () => {
  const urls = HTML.match(/https?:\/\/[^\s"'`<>)]+/g) || [];
  assert.ok(urls.length > 0);
  const allowed = /^(http:\/\/localhost:3846\/|https:\/\/www\.figma\.com\/design\/)/;
  for (const url of urls) assert.match(url, allowed, `unexpected URL: ${url}`);
  assert.doesNotMatch(HTML, /<link\b/i, 'no <link> (no Google Fonts or other stylesheets)');
  assert.doesNotMatch(HTML, /<script\b[^>]*\bsrc=/i, 'no external scripts');
  assert.doesNotMatch(HTML, /@import|url\(\s*['"]?https?:/i, 'no external CSS resources');
});

test('ui.html is always light: color-scheme light is set', () => {
  assert.match(HTML, /color-scheme:\s*light\b/);
});

test('ui.html ignores the system or Figma theme: no prefers-color-scheme', () => {
  assert.doesNotMatch(HTML, /prefers-color-scheme/);
});

// ---- Header logo: inline decorative SVG instead of the ✦ glyph ----

test('ui.html header has an inline decorative SVG logo next to the title', () => {
  const header = HTML.match(/<div class="head">[\s\S]*?<\/h1>/);
  assert.ok(header, 'header row found');
  assert.match(header[0], /<h1><svg class="logo"[^>]*aria-hidden="true"[^>]*>/);
  assert.match(header[0], /<\/svg>Виділені ноди<\/h1>/);
});

test('ui.html no longer uses the ✦ glyph anywhere', () => {
  assert.doesNotMatch(HTML, /✦/);
});

// ---- Settings tab (copy format, token, send switch) and the header status dot ----

test('ui.html header dot is a button next to the title, inside the header row', () => {
  const header = HTML.match(/<div class="head">[\s\S]*?<div class="head-end">/);
  assert.ok(header, 'header row found');
  assert.match(header[0], /<\/h1>\s*<button id="healthDot" class="health-dot off" type="button"/);
});

test('ui.html header dot mirrors the server state, with a text label in aria-label and title', async (t) => {
  const cases = [
    ['sending off', null, null, 'health-dot off', 'Стан сервера: надсилання в Claude вимкнено'],
    ['running and authorized', 'secret', healthResponse({ ok: true, authorized: true }), 'health-dot ok', 'Стан сервера: Сервер працює'],
    ['running, wrong token', 'secret', healthResponse({ ok: true, authorized: false }), 'health-dot err', 'Стан сервера: Сервер працює, невірний токен'],
    ['running, token empty', '  ', healthResponse({ ok: true, authorized: false }), 'health-dot err', 'Стан сервера: Сервер працює, введіть токен'],
    ['not running', 'secret', () => Promise.reject(new TypeError('Failed to fetch')), 'health-dot err', 'Стан сервера: Сервер не запущений'],
  ];
  for (const [name, token, fetchImpl, className, label] of cases) {
    await t.test(name, async () => {
      const ui = fetchImpl ? loadUi({ fetchImpl }) : loadUi();
      if (token !== null) {
        ui.elements.token.value = token;
        enableSendToggle(ui);
        await flush();
      }
      const dot = ui.elements.healthDot;
      assert.equal(dot.className, className);
      assert.equal(dot.getAttribute('aria-label'), label);
      assert.equal(dot.getAttribute('title'), label);
    });
  }
});

test('ui.html header dot is grey while the first health check is still running', () => {
  const ui = loadUi({ fetchImpl: () => new Promise(() => {}) });
  ui.elements.token.value = 'secret';
  enableSendToggle(ui);
  assert.equal(ui.elements.healthDot.className, 'health-dot off');
  assert.equal(ui.elements.healthDot.getAttribute('aria-label'), 'Стан сервера: перевірка…');
});

test('ui.html a 401 on a selection POST turns the header dot red', async () => {
  const ui = loadSendingUi({ fetchImpl: () => Promise.resolve({ ok: false, status: 401 }) });
  ui.sendSelection('abc', NODES);
  await flush();
  assert.equal(ui.elements.healthDot.className, 'health-dot err');
});

test('ui.html clicking the header dot opens the settings tab', () => {
  const ui = loadUi();
  const { healthDot, tabSettings, tabSelection, panelSettings, panelSelection } = ui.elements;
  healthDot.dispatch('click', {});
  assert.equal(tabSettings.getAttribute('aria-selected'), 'true');
  assert.equal(tabSelection.getAttribute('aria-selected'), 'false');
  assert.equal(panelSettings.hidden, false);
  assert.equal(panelSelection.hidden, true);
});

test('ui.html saves the copy format with the other settings and restores it from the plugin', () => {
  const ui = loadUi();
  const { format } = ui.elements;
  format.value = 'idname';
  format.dispatch('change', {});
  assert.deepEqual(plain(ui.posted[ui.posted.length - 1].msg), {
    pluginMessage: { type: 'save-settings', settings: { send: false, token: '', format: 'idname' } },
  });

  ui.sendPlugin({ type: 'settings', settings: { send: false, token: '', format: 'claude' } });
  assert.equal(format.value, 'claude');
});

test('ui.html applies only a known format; settings without format keep the current choice', () => {
  const ui = loadUi();
  ui.sendPlugin({ type: 'settings', settings: { send: false, token: '', format: 'link' } });
  assert.equal(ui.elements.format.value, 'link');
  ui.sendPlugin({ type: 'settings', settings: { send: false, token: '' } });
  assert.equal(ui.elements.format.value, 'link', 'older settings without format keep the choice');
  ui.sendPlugin({ type: 'settings', settings: { send: false, token: '', format: 'bogus' } });
  assert.equal(ui.elements.format.value, 'link', 'an unknown format is ignored');
});

test('ui.html format options match the copy formats accepted by code.ts', () => {
  const optionValues = [...HTML.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]);
  const codeSrc = fs.readFileSync(path.join(ROOT, 'code.ts'), 'utf8');
  const listed = codeSrc.match(/const COPY_FORMATS: readonly CopyFormat\[\] = \[([^\]]*)\]/)[1];
  assert.deepEqual(listed.match(/'[^']+'/g).map((s) => s.slice(1, -1)), optionValues);
  const scriptValues = SCRIPT.match(/var FORMAT_VALUES = \[([^\]]*)\]/)[1];
  assert.deepEqual(scriptValues.match(/'[^']+'/g).map((s) => s.slice(1, -1)), optionValues);
});

// ---- Record cards and the record view (Записи tab) ----

// Fixed "now" for the relative-time tests (local time; 9 November 2026, 12:00).
const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime();

// The card at a list position, and its open part (the real button).
function cardOf(ui, index) {
  return ui.elements.recordsList.children[index];
}

function openCard(ui, index) {
  byClass(cardOf(ui, index), 'rec-open')[0].dispatch('click', {});
}

test('ui.html records cards: names with type pills, the note, and no ids or file key', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  openRecords(ui);
  await flush();
  const card = cardOf(ui, 0);
  assert.equal(card.className, 'rec');
  assert.deepEqual(
    byClass(card, 'rec-el').map((el) => [el.children[0].textContent, el.children[1].textContent]),
    [['FRAME', 'Button'], ['RECTANGLE', 'Card']]
  );
  assert.equal(byClass(card, 'rec-count')[0].textContent, '2 елементи');
  assert.equal(byClass(card, 'rec-note')[0].textContent, RECORD_A.note, 'the note is shown as text');
  assert.equal(byClass(card, 'badge')[0].textContent, 'нове');
  const text = card.textContent;
  for (const hidden of ['1:2', '1:3', 'abcdefghij', 'abcdef…', 'fileKey', 'hasDetail', 'nodeCount', 'id:']) {
    assert.ok(!text.includes(hidden), `the card text must not contain ${hidden}`);
  }
});

test('ui.html records cards: three names then «+N», and «Без коментаря» without a note', async () => {
  const five = {
    id: 11, status: 'new', fileKey: 'k', receivedAt: RECORD_B.receivedAt, nodeCount: 5, hasDetail: false,
    nodes: ['A', 'B', 'C', 'D', 'E'].map((name, i) => ({ id: `4:${i}`, name, type: 'TEXT' })),
  };
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([five, RECORD_B])) });
  openRecords(ui);
  await flush();
  const first = cardOf(ui, 0);
  assert.deepEqual(byClass(first, 'rec-el').map((el) => el.children[1].textContent), ['A', 'B', 'C']);
  assert.deepEqual(byClass(first, 'rec-more').map((el) => el.textContent), ['+2']);
  assert.equal(byClass(first, 'rec-count')[0].textContent, '5 елементів');
  assert.equal(byClass(first, 'rec-note empty')[0].textContent, 'Без коментаря');

  const second = cardOf(ui, 1);
  assert.equal(byClass(second, 'rec-count').length, 0, 'one element: no count');
  assert.equal(byClass(second, 'rec-more').length, 0);
  assert.equal(byClass(second, 'rec-note empty')[0].textContent, 'Без коментаря');
});

test('ui.html records cards: the element count uses the Ukrainian plural of "елемент"', async (t) => {
  const cases = [[2, '2 елементи'], [4, '4 елементи'], [5, '5 елементів'], [11, '11 елементів'], [21, '21 елемент'], [22, '22 елементи']];
  for (const [nodeCount, expected] of cases) {
    await t.test(`nodeCount=${nodeCount}`, async () => {
      const record = { id: nodeCount, status: 'new', fileKey: 'k', receivedAt: RECORD_B.receivedAt, nodeCount, nodes: [], hasDetail: false };
      const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([record])) });
      openRecords(ui);
      await flush();
      assert.equal(byClass(cardOf(ui, 0), 'rec-count')[0].textContent, expected);
    });
  }
});

test('ui.html records cards: relative time for recent records, «вчора», then the local date', async () => {
  const recs = [
    { ...RECORD_B, id: 1, receivedAt: new Date(NOW - 30 * 1000).toISOString() },
    { ...RECORD_B, id: 2, receivedAt: new Date(NOW - 5 * 60 * 1000).toISOString() },
    { ...RECORD_B, id: 3, receivedAt: new Date(NOW - 3 * 3600 * 1000).toISOString() },
    { ...RECORD_B, id: 4, receivedAt: new Date(NOW - 13 * 3600 * 1000).toISOString() },
    { ...RECORD_B, id: 5, receivedAt: new Date(2026, 10, 6, 10, 20).toISOString() },
  ];
  const ui = loadSendingUi({ now: NOW, fetchImpl: withRecords(recordsResponse(recs)) });
  openRecords(ui);
  await flush();
  const times = recs.map((_, i) => byClass(cardOf(ui, i), 'rec-time')[0].textContent);
  assert.deepEqual(times, ['щойно', '5 хв тому', '3 год тому', 'вчора', '06.11.2026']);
});

test('ui.html records: clicking a card opens the record view with every name, the full note and a collapsed technical block', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  openRecords(ui);
  await flush();
  openCard(ui, 0);
  const { recordView, recordsList, recordsCurrent, recordViewBody } = ui.elements;
  assert.equal(recordView.hidden, false);
  assert.equal(recordsList.hidden, true, 'the view replaces the list');
  assert.equal(recordsCurrent.hidden, true);
  assert.deepEqual(byClass(recordViewBody, 'rec-view-el').map((el) => el.children[1].textContent), ['Button', 'Card']);
  const note = byClass(recordViewBody, 'rec-view-note')[0];
  assert.equal(note.textContent, RECORD_A.note);
  assert.equal(note.children.length, 0, 'the note is a text node, not markup');
  assert.equal(byClass(recordViewBody, 'rec-tech')[0].hidden, true, 'the technical block starts collapsed');
  const techBtn = descendants(recordViewBody).find((n) => n.tagName === 'button' && n.textContent === 'Технічні дані');
  assert.equal(techBtn.getAttribute('aria-expanded'), 'false');
  assert.equal(ui.elements.recordsTabLabel.textContent, 'Записи (1)', 'the count is unchanged by opening a record');
});

test('ui.html records: the note keeps its line breaks; «Назад» and Escape return to the list', async () => {
  const multi = { ...RECORD_B, id: 9, note: 'перший рядок\n\n  другий рядок' };
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([multi, RECORD_A])) });
  openRecords(ui);
  await flush();
  openCard(ui, 0);
  assert.equal(byClass(ui.elements.recordViewBody, 'rec-view-note')[0].textContent, multi.note);

  ui.elements.recordBack.dispatch('click', {});
  assert.equal(ui.elements.recordView.hidden, true);
  assert.equal(ui.elements.recordsList.hidden, false);
  assert.equal(ui.elements.recordsList.children.length, 2);

  openCard(ui, 1);
  assert.equal(ui.elements.recordView.hidden, false);
  ui.keyDocument({ key: 'Enter' });
  assert.equal(ui.elements.recordView.hidden, false, 'Enter does not close the view');
  ui.keyDocument({ key: 'Escape' });
  assert.equal(ui.elements.recordView.hidden, true, 'Escape returns to the list');
  assert.equal(ui.elements.recordsList.hidden, false);
});

test('ui.html records: the technical block lists the ids, fileKey, nodeCount and hasDetail', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  openRecords(ui);
  await flush();
  openCard(ui, 0);
  const view = ui.elements.recordViewBody;
  const techBtn = descendants(view).find((n) => n.tagName === 'button' && n.textContent === 'Технічні дані');
  techBtn.dispatch('click', {});
  assert.equal(techBtn.getAttribute('aria-expanded'), 'true');
  assert.equal(byClass(view, 'rec-tech')[0].hidden, false);
  assert.deepEqual(byClass(view, 'rec-tech-line').map((l) => l.textContent), [
    'id: 7',
    'fileKey: abcdefghij',
    'nodeCount: 2',
    'hasDetail: true',
    '1:2 · Button · FRAME',
    '1:3 · Card · RECTANGLE',
  ]);
});

test('ui.html records: the record view shows «ще N» when a record has more than 20 nodes', async () => {
  const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `6:${i}`, name: `N${i}`, type: 'FRAME' }));
  const big = { id: 12, status: 'new', fileKey: 'k', receivedAt: RECORD_B.receivedAt, nodeCount: 23, nodes, hasDetail: false };
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([big])) });
  openRecords(ui);
  await flush();
  openCard(ui, 0);
  assert.equal(byClass(ui.elements.recordViewBody, 'rec-view-el').length, 20);
  assert.equal(byClass(ui.elements.recordViewBody, 'rec-view-more')[0].textContent, 'ще 3');
});

test('ui.html records: the status toggle works from the card and from the record view', async () => {
  const ui = loadSendingUi({
    fetchImpl: withRecordsAndStatus(recordsResponse([RECORD_A]), statusResponse(200, { ok: true, record: { id: 7, status: 'done' } })),
  });
  openRecords(ui);
  await flush();
  statusButton(ui, 'Позначити виконаним').dispatch('click', {});
  await flush();
  assert.equal(statusCalls(ui).length, 1, 'from the card');
  assert.deepEqual(JSON.parse(statusCalls(ui)[0].init.body), { status: 'done' });

  openCard(ui, 0);
  await flush();
  const viewBtn = descendants(ui.elements.recordViewBody).find((n) => n.tagName === 'button' && n.textContent === 'Позначити виконаним');
  assert.ok(viewBtn, 'the view offers the same toggle');
  viewBtn.dispatch('click', {});
  await flush();
  assert.equal(statusCalls(ui).length, 2, 'from the view');
  assert.equal(statusCalls(ui)[1].url, STATUS_URL);
  assert.deepEqual(JSON.parse(statusCalls(ui)[1].init.body), { status: 'done' });
});

test('ui.html records: turning sending off closes the record view', async () => {
  const ui = loadSendingUi({ fetchImpl: withRecords(recordsResponse([RECORD_A])) });
  openRecords(ui);
  await flush();
  openCard(ui, 0);
  ui.elements.send.checked = false;
  ui.elements.send.dispatch('change', {});
  assert.equal(ui.elements.recordView.hidden, true);
  assert.equal(ui.elements.recordsHint.hidden, false);
});

test('ui.html records markup: cards are buttons, the view sits in the records panel and starts hidden', () => {
  assert.match(HTML, /<div id="recordView" class="rec-view" hidden>/);
  assert.match(HTML, /<button id="recordBack" class="secondary rec-view-back" type="button">← Назад до записів<\/button>/);
  assert.match(SCRIPT, /makeEl\('button', 'rec-open'\)/, 'the open part of a card is a real button');
  assert.ok(HTML.indexOf('id="recordView"') > HTML.indexOf('id="panelRecords"'));
  const style = HTML.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(style, /opacity/, 'muted cards use colour, not opacity');
});

// ---- Children of the selected nodes (Виділення tab) ----

function sel(id, name, type, childCount, children) {
  return { id, name, type, childCount, children };
}

// n children named C1..Cn, all TEXT.
function kidsList(n) {
  return Array.from({ length: n }, (_, i) => ({ name: `C${i + 1}`, type: 'TEXT' }));
}

function rowOf(ui, index) {
  return ui.elements.list.children[index];
}

// The children holder of a row (its last child).
function kidsHolder(ui, index) {
  return byClass(rowOf(ui, index), 'kids')[0];
}

function kidNames(ui, index) {
  return byClass(rowOf(ui, index), 'kid').map((k) => byClass(k, 'nm')[0].textContent);
}

function kidButtons(ui, index) {
  return descendants(kidsHolder(ui, index)).filter((n) => n.tagName === 'button');
}

function kidButtonText(ui, index) {
  return kidButtons(ui, index).map((b) => b.textContent);
}

test('ui.html children: four pills first, «ще N» expands to every child sent and back to four', () => {
  const ui = loadUi();
  ui.sendSelection('FK1', [sel('1:2', 'Button', 'FRAME', 7, kidsList(7))]);
  assert.deepEqual(kidNames(ui, 0), ['C1', 'C2', 'C3', 'C4']);
  assert.deepEqual(kidButtonText(ui, 0), ['ще 3']);
  assert.equal(kidButtons(ui, 0)[0].getAttribute('aria-expanded'), 'false');

  kidButtons(ui, 0)[0].dispatch('click', {});
  assert.equal(kidNames(ui, 0).length, 7);
  assert.deepEqual(kidButtonText(ui, 0), ['згорнути']);
  assert.equal(kidButtons(ui, 0)[0].getAttribute('aria-expanded'), 'true');
  assert.equal(byClass(kidsHolder(ui, 0), 'kid-rest').length, 0, 'everything was sent: no «…і ще» line');

  kidButtons(ui, 0)[0].dispatch('click', {});
  assert.deepEqual(kidNames(ui, 0), ['C1', 'C2', 'C3', 'C4']);
});

test('ui.html children: a count above the number sent shows a final «…і ще M» line once expanded', () => {
  const ui = loadUi();
  ui.sendSelection('FK1', [sel('1:2', 'Frame', 'FRAME', 25, kidsList(20)), sel('1:3', 'Card', 'FRAME', 0, [])]);
  assert.deepEqual(kidButtonText(ui, 0), ['ще 21']);
  kidButtons(ui, 0)[0].dispatch('click', {});
  assert.equal(kidNames(ui, 0).length, 20);
  const rest = byClass(kidsHolder(ui, 0), 'kid-rest');
  assert.deepEqual(rest.map((r) => r.textContent), ['…і ще 5']);
  assert.equal(rest[0].tagName, 'div', 'the line is not interactive');
  assert.equal(kidsHolder(ui, 1).children.length, 0, 'a node without children adds nothing');
});

test('ui.html children: with more than two nodes the rows are compact and children sit behind «N дочірніх»', () => {
  const ui = loadUi();
  ui.sendSelection('FK1', [
    sel('1:2', 'Button', 'FRAME', 6, kidsList(6)),
    sel('1:3', 'Card', 'FRAME', 0, []),
    sel('1:4', 'Title', 'TEXT', 1, kidsList(1)),
  ]);
  assert.equal(ui.elements.list.className, 'list compact');
  assert.deepEqual(kidButtonText(ui, 0), ['6 дочірніх']);
  assert.deepEqual(kidNames(ui, 0), [], 'collapsed by default');
  assert.equal(kidsHolder(ui, 1).children.length, 0);
  assert.deepEqual(kidButtonText(ui, 2), ['1 дочірній']);

  kidButtons(ui, 0)[0].dispatch('click', {});
  assert.equal(kidButtons(ui, 0)[0].getAttribute('aria-expanded'), 'true');
  assert.deepEqual(kidNames(ui, 0), ['C1', 'C2', 'C3', 'C4']);
  assert.deepEqual(kidButtonText(ui, 0), ['6 дочірніх', 'ще 2']);

  kidButtons(ui, 0)[1].dispatch('click', {});
  assert.equal(kidNames(ui, 0).length, 6);

  kidButtons(ui, 0)[0].dispatch('click', {});
  assert.deepEqual(kidNames(ui, 0), [], 'the toggle closes the pills');
});

test('ui.html children: with two nodes or fewer the roomy layout shows four pills and no toggle', () => {
  const ui = loadUi();
  ui.sendSelection('FK1', [sel('1:2', 'Button', 'FRAME', 2, kidsList(2)), sel('1:3', 'Card', 'FRAME', 1, kidsList(1))]);
  assert.equal(ui.elements.list.className, 'list');
  assert.deepEqual(kidNames(ui, 0), ['C1', 'C2']);
  assert.deepEqual(kidButtonText(ui, 0), []);
  assert.deepEqual(kidNames(ui, 1), ['C1']);
  assert.deepEqual(kidButtonText(ui, 1), []);
});

test('ui.html children: the expansion is kept while the selection stays and reset when it changes', () => {
  const ui = loadUi();
  const a = sel('1:2', 'Button', 'FRAME', 7, kidsList(7));
  const b = sel('1:3', 'Card', 'FRAME', 0, []);
  ui.sendSelection('FK1', [a, b]);
  kidButtons(ui, 0)[0].dispatch('click', {});
  assert.equal(kidNames(ui, 0).length, 7);

  ui.sendSelection('FK1', [{ ...b }, { ...a }]);
  assert.equal(kidNames(ui, 1).length, 7, 'the same ids in another order: kept');

  ui.sendSelection('FK1', [{ ...a }]);
  assert.deepEqual(kidNames(ui, 0), ['C1', 'C2', 'C3', 'C4'], 'other nodes: reset');
  ui.sendSelection('FK1', [{ ...a }, { ...b }]);
  assert.deepEqual(kidNames(ui, 0), ['C1', 'C2', 'C3', 'C4'], 'the reset is not undone');
});

test('ui.html children: the POST bodies carry only id, name and type of each node', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', [sel('1:2', 'Button', 'FRAME', 2, kidsList(2))]);
  await flush();
  assert.deepEqual(bodyOf(postCalls(ui)[0]).nodes, [{ id: '1:2', name: 'Button', type: 'FRAME' }]);

  ui.elements.detailBtn.dispatch('click', {});
  reply(ui, lastDetailRequest(ui).requestId, ['1:2']);
  await flush();
  const detailBody = bodyOf(postCalls(ui)[postCalls(ui).length - 1]);
  assert.ok('detail' in detailBody, 'the detail POST went out');
  assert.deepEqual(detailBody.nodes, [{ id: '1:2', name: 'Button', type: 'FRAME' }]);
});

test('ui.html children: a node without children adds nothing; broken or missing fields do not break the list', () => {
  const ui = loadUi();
  ui.sendSelection('FK1', [
    { id: '1:2', name: 'Button', type: 'FRAME' },
    { id: '1:3', name: 'Card', type: 'RECTANGLE', childCount: 'many', children: 'none' },
  ]);
  assert.equal(kidsHolder(ui, 0).children.length, 0);
  assert.equal(kidsHolder(ui, 1).children.length, 0);
  assert.equal(ui.elements.count.textContent, '2');
});
