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
function loadUi({ clipboard, execCommand, fetchImpl } = {}) {
  const elements = {};
  for (const id of ['count', 'list', 'format', 'auto', 'copy', 'status', 'send', 'token', 'health', 'sendStatus',
    'detailBtn', 'commentToggle', 'commentBox', 'comment', 'commentCount', 'commentSend']) {
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
  const { detailBtn, commentToggle, commentSend } = ui.elements;
  const enabled = () => !detailBtn.disabled && !commentToggle.disabled && !commentSend.disabled;

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

test('ui.html "Додати деталі" posts request-detail with an incrementing requestId', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();

  ui.elements.detailBtn.dispatch('click', {});
  assert.deepEqual(plain(ui.posted[ui.posted.length - 1]), {
    msg: { pluginMessage: { type: 'request-detail', requestId: 1 } },
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
  const { detailBtn, commentToggle, commentSend } = ui.elements;

  detailBtn.dispatch('click', {});
  assert.equal(detailBtn.disabled, true);
  assert.equal(commentToggle.disabled, true);
  assert.equal(commentSend.disabled, true);

  reply(ui, 1, SAME_IDS); // the POST is in flight now
  assert.equal(detailBtn.disabled, true);
  await flush();
  assert.equal(detailBtn.disabled, false);
  assert.equal(commentToggle.disabled, false);
  assert.equal(commentSend.disabled, false);
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
  assert.equal(ui.elements.sendStatus.textContent, 'Деталі надіслано');
  assert.equal(ui.elements.sendStatus.className, 'status ok');
  assert.equal(ui.elements.detailBtn.disabled, false);
});

test('ui.html comment flow reveals the textarea, then POSTs detail with the trimmed note', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();
  const { commentToggle, commentBox, comment, commentCount, commentSend } = ui.elements;

  assert.equal(commentBox.hidden, true);
  assert.equal(commentToggle.getAttribute('aria-expanded'), 'false');
  commentToggle.dispatch('click', {});
  assert.equal(commentBox.hidden, false);
  assert.equal(commentToggle.getAttribute('aria-expanded'), 'true');

  typeComment(ui, '  Перевір відступи  ');
  assert.equal(commentCount.textContent, '20/2000');

  commentSend.dispatch('click', {});
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
  assert.equal(commentBox.hidden, true);
  assert.equal(commentToggle.getAttribute('aria-expanded'), 'false');
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
  const { commentToggle, commentBox, comment, commentCount } = ui.elements;
  commentToggle.dispatch('click', {});
  typeComment(ui, 'Тримати');

  ui.sendSelection('FK1', NODES.slice().reverse().map((n) => ({ ...n })));
  assert.equal(comment.value, 'Тримати');
  assert.equal(commentBox.hidden, false);

  ui.sendSelection('FK1', [NODES[0]]);
  assert.equal(comment.value, '');
  assert.equal(commentCount.textContent, '0/2000');
  assert.equal(commentBox.hidden, true);
  assert.equal(commentToggle.getAttribute('aria-expanded'), 'false');
});

test('ui.html omits note when the comment is blank', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();

  ui.elements.commentToggle.dispatch('click', {});
  typeComment(ui, '  \n ');
  ui.elements.commentSend.dispatch('click', {});
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

  ui.elements.commentToggle.dispatch('click', {});
  typeComment(ui, 'я'.repeat(2500));
  assert.equal(ui.elements.comment.value.length, 2000);
  assert.equal(ui.elements.commentCount.textContent, '2000/2000');

  ui.elements.commentSend.dispatch('click', {});
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

  ui.elements.commentToggle.dispatch('click', {});
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

  ui.elements.commentToggle.dispatch('click', {});
  typeComment(ui, 'Зауваження');
  ui.elements.commentSend.dispatch('click', {});
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
  assert.equal(ui.elements.commentBox.hidden, false);
  assert.equal(ui.elements.detailBtn.disabled, false);
});

test('ui.html detail markup: toggle aria wiring, labelled textarea, maxlength 2000, no old note UI', () => {
  assert.match(HTML, /<button id="commentToggle"[^>]*aria-expanded="false"[^>]*aria-controls="commentBox"/);
  assert.match(HTML, /<label for="comment">/);
  assert.match(HTML, /<textarea id="comment"[^>]*maxlength="2000"[^>]*placeholder="Коментар для Claude…"/);
  assert.match(HTML, /id="detailBtn"[^>]*>Додати деталі</);
  assert.match(HTML, /id="commentToggle"[^>]*>Додати деталі з коментарем</);
  assert.match(HTML, /id="commentSend"[^>]*>Відправити</);
  assert.doesNotMatch(HTML, /noteToggle|Написати нотатку/);
});

test('ui.html never persists the comment to the plugin', async () => {
  const ui = loadSendingUi();
  ui.sendSelection('FK1', NODES);
  await flush();

  ui.elements.commentToggle.dispatch('click', {});
  typeComment(ui, 'секретна нотатка');
  ui.elements.commentSend.dispatch('click', {});
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
