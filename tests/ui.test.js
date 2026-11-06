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
    textContent: '',
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
    setAttribute() {},
    setSelectionRange() {},
    select() {},
    remove() {
      this.removed = true;
    },
  };
}

// Builds a fresh DOM/window/navigator/parent stub and runs ui.html's script in it.
// fetchImpl(url, init) stubs the global fetch; the default answers 200 ok.
function loadUi({ clipboard, execCommand, fetchImpl } = {}) {
  const elements = {};
  for (const id of ['count', 'list', 'format', 'auto', 'copy', 'status', 'send', 'token', 'health', 'sendStatus']) {
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
    return fetchImpl
      ? fetchImpl(url, init)
      : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, authorized: true }) });
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

test('ui.html applies stored settings from the plugin', async () => {
  const ui = loadUi();
  ui.sendPlugin({ type: 'settings', settings: { send: true, token: 'stored-token' } });
  assert.equal(ui.elements.send.checked, true);
  assert.equal(ui.elements.token.value, 'stored-token');
  await flush();
  assert.deepEqual(
    ui.fetchCalls.map((c) => c.url),
    ['http://localhost:3846/health'],
    'loading settings only checks /health, never POSTs the selection'
  );
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
    msg: { pluginMessage: { type: 'save-settings', settings: { send: true, token: 'secret' } } },
    target: '*',
  });
});

test('ui.html saves the token to the plugin on each input', () => {
  const ui = loadUi();
  ui.elements.send.checked = false;
  ui.elements.token.value = 'abc';
  ui.elements.token.dispatch('input', {});
  assert.deepEqual(plain(ui.posted[ui.posted.length - 1].msg), {
    pluginMessage: { type: 'save-settings', settings: { send: false, token: 'abc' } },
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

  const debounced = ui.timers.filter((t) => t.ms === 400);
  assert.equal(debounced.length, 2);
  assert.equal(debounced[0].cleared, true, 'the first debounce is superseded');
  debounced[1].fn();
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
