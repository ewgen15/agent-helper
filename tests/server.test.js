'use strict';
// Regression tests for server/index.js: HTTP endpoint and MCP stdio server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnServer, stopChild, httpRequest, VALID_BODY, SERVER_PATH, freePort } = require('./helpers');
const { spawn } = require('node:child_process');

const TOKEN = 'test';
const FIGMA = 'https://www.figma.com';

test('server/index.js HTTP endpoint', async (t) => {
  const { child, port } = await spawnServer();
  t.after(() => stopChild(child));

  const post = (headers = {}, body = VALID_BODY) =>
    httpRequest(port, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });

  await t.test('401 when x-token is missing', async () => {
    const res = await post({});
    assert.equal(res.status, 401);
  });

  await t.test('401 when x-token is wrong', async () => {
    const res = await post({ 'x-token': 'wrong' });
    assert.equal(res.status, 401);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  await t.test('403 for Origin https://evil.com, even with a valid token', async () => {
    const res = await post({ 'x-token': TOKEN, Origin: 'https://evil.com' });
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  await t.test('200 for valid token with Origin missing', async () => {
    const res = await post({ 'x-token': TOKEN });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.ok, true);
    assert.equal(body.count, 1);
  });

  await t.test("200 for valid token with Origin 'null'", async () => {
    const res = await post({ 'x-token': TOKEN, Origin: 'null' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'null');
  });

  await t.test('200 for valid token with Origin https://www.figma.com', async () => {
    const res = await post({ 'x-token': TOKEN, Origin: FIGMA });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], FIGMA);
  });

  await t.test('400 for bad JSON', async () => {
    const res = await post({ 'x-token': TOKEN }, '{not json');
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.text).error, 'invalid JSON');
  });

  await t.test('400 for JSON with the wrong shape', async () => {
    const res = await post({ 'x-token': TOKEN }, JSON.stringify({ fileKey: '', nodes: [] }));
    assert.equal(res.status, 400);
  });

  await t.test('200 when fileKey is null (plugin has no figma.fileKey)', async () => {
    const body = JSON.stringify({ fileKey: null, nodes: [{ id: '1:2', name: 'Button', type: 'FRAME' }] });
    const res = await post({ 'x-token': TOKEN }, body);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).count, 1);
  });

  await t.test('200 when fileKey is omitted', async () => {
    const body = JSON.stringify({ nodes: [{ id: '1:2', name: 'Button', type: 'FRAME' }] });
    const res = await post({ 'x-token': TOKEN }, body);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).ok, true);
  });

  await t.test('400 when fileKey is a number', async () => {
    const body = JSON.stringify({ fileKey: 123, nodes: [] });
    const res = await post({ 'x-token': TOKEN }, body);
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.text).error, 'fileKey must be a non-empty string or null');
  });

  await t.test('400 when fileKey is an object', async () => {
    const body = JSON.stringify({ fileKey: { key: 'abc' }, nodes: [] });
    const res = await post({ 'x-token': TOKEN }, body);
    assert.equal(res.status, 400);
  });

  await t.test('413 for a body larger than 100KB', async () => {
    const big = JSON.stringify({
      fileKey: 'abc123',
      nodes: [],
      pad: 'x'.repeat(100 * 1024 + 1024),
    });
    const res = await post({ 'x-token': TOKEN }, big);
    assert.equal(res.status, 413);
  });

  await t.test('OPTIONS preflight is 204 with CORS headers for https://www.figma.com', async () => {
    const res = await httpRequest(port, {
      method: 'OPTIONS',
      headers: { Origin: FIGMA, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], FIGMA);
    assert.match(res.headers['access-control-allow-headers'], /x-token/i);
  });

  await t.test("OPTIONS preflight is 204 with CORS headers for Origin 'null'", async () => {
    const res = await httpRequest(port, { method: 'OPTIONS', headers: { Origin: 'null' } });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'null');
  });

  await t.test('OPTIONS preflight without Origin is 204 and sends no CORS headers', async () => {
    const res = await httpRequest(port, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  await t.test('OPTIONS preflight from an evil origin gets no CORS headers', async () => {
    const res = await httpRequest(port, { method: 'OPTIONS', headers: { Origin: 'https://evil.com' } });
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
});

test('server/index.js GET /health', async (t) => {
  const HEALTH_TOKEN = 'health-secret-token-0042';
  const { child, port } = await spawnServer({ FIGMA_SELECTION_TOKEN: HEALTH_TOKEN });
  t.after(() => stopChild(child));

  const health = (headers = {}) => httpRequest(port, { method: 'GET', path: '/health', headers });

  await t.test('200 with authorized:false when x-token is missing', async () => {
    const res = await health();
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { ok: true, authorized: false });
  });

  await t.test('200 with authorized:false when x-token is wrong', async () => {
    const res = await health({ 'x-token': 'wrong' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { ok: true, authorized: false });
  });

  await t.test('200 with authorized:true when x-token is right', async () => {
    const res = await health({ 'x-token': HEALTH_TOKEN });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { ok: true, authorized: true });
  });

  await t.test('403 for Origin https://evil.com, even with a valid token', async () => {
    const res = await health({ 'x-token': HEALTH_TOKEN, Origin: 'https://evil.com' });
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  await t.test("CORS headers are present for Origin 'null'", async () => {
    const res = await health({ Origin: 'null' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'null');
  });

  await t.test('OPTIONS preflight is 204 and allows x-token', async () => {
    const res = await httpRequest(port, {
      method: 'OPTIONS',
      path: '/health',
      headers: { Origin: FIGMA, 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], FIGMA);
    assert.match(res.headers['access-control-allow-headers'], /x-token/i);
  });

  await t.test('body never contains the token', async () => {
    const responses = [
      await health(),
      await health({ 'x-token': 'wrong' }),
      await health({ 'x-token': HEALTH_TOKEN }),
    ];
    for (const res of responses) {
      assert.doesNotMatch(res.text, /health-secret-token/);
    }
  });

  await t.test('body never leaks the stored selection', async () => {
    const post = await httpRequest(port, {
      method: 'POST',
      headers: { 'x-token': HEALTH_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileKey: 'k', nodes: [{ id: '9:9', name: 'SecretFrame', type: 'FRAME' }] }),
    });
    assert.equal(post.status, 200);
    const res = await health({ 'x-token': HEALTH_TOKEN });
    assert.deepEqual(JSON.parse(res.text), { ok: true, authorized: true });
    assert.doesNotMatch(res.text, /SecretFrame|9:9/);
  });

  await t.test('other methods are 405', async () => {
    const res = await httpRequest(port, { method: 'POST', path: '/health', headers: { 'x-token': HEALTH_TOKEN } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, OPTIONS');
  });

  await t.test('logs nothing on repeated calls', async () => {
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    for (let i = 0; i < 5; i++) {
      await health({ 'x-token': HEALTH_TOKEN });
      await health({ Origin: 'https://evil.com' });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(stderr, '');
  });
});

test('server/index.js MCP over stdio', async (t) => {
  const { child: httpChild } = await spawnServer();
  t.after(() => stopChild(httpChild));

  // A separate process for MCP, speaking JSON-RPC over stdin/stdout.
  const mcpPort = await freePort();
  const mcp = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(mcpPort), FIGMA_SELECTION_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    mcp.stdin.end();
    await stopChild(mcp);
  });
  mcp.stderr.resume();

  const pending = new Map();
  let buffer = '';
  const rawLines = [];
  mcp.stdout.setEncoding('utf8');
  mcp.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      rawLines.push(line);
      const msg = JSON.parse(line);
      const key = String(msg.id);
      if (pending.has(key)) {
        pending.get(key)(msg);
        pending.delete(key);
      }
    }
  });

  let nextId = 1;
  const rpc = (method, params) => {
    const id = nextId++;
    const response = new Promise((resolve) => pending.set(String(id), resolve));
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return response;
  };
  const callTool = async () => {
    const msg = await rpc('tools/call', { name: 'get_figma_selection', arguments: {} });
    assert.equal(msg.result.content[0].type, 'text');
    return msg.result.content[0].text;
  };

  await t.test('initialize returns protocol version and tools capability', async () => {
    const msg = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(msg.jsonrpc, '2.0');
    assert.equal(msg.result.protocolVersion, '2024-11-05');
    assert.ok(msg.result.capabilities.tools);
    assert.equal(msg.result.serverInfo.name, 'figma-selection');
  });

  await t.test('tools/list contains get_figma_selection', async () => {
    const msg = await rpc('tools/list', {});
    const names = msg.result.tools.map((tool) => tool.name);
    assert.ok(names.includes('get_figma_selection'), `tools: ${names.join(',')}`);
  });

  await t.test('tools/call returns "Немає виділення" when nothing was posted', async () => {
    assert.equal(await callTool(), 'Немає виділення');
  });

  await t.test('tools/call returns the selection after a POST to /selection', async () => {
    const res = await httpRequest(mcpPort, {
      method: 'POST',
      headers: { 'x-token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileKey: 'abc', nodes: [{ id: '1:2', name: 'Button', type: 'FRAME' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(await callTool(), 'Figma nodes:\n1:2 "Button" (FRAME)');
  });

  await t.test('tools/call prints nodes without "null"/"undefined" after a POST with fileKey null', async () => {
    const res = await httpRequest(mcpPort, {
      method: 'POST',
      headers: { 'x-token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileKey: null, nodes: [{ id: '2:3', name: 'Icon', type: 'VECTOR' }] }),
    });
    assert.equal(res.status, 200);
    const text = await callTool();
    assert.equal(text, 'Figma nodes:\n2:3 "Icon" (VECTOR)');
    assert.doesNotMatch(text, /null|undefined/);
  });

  await t.test('unknown method returns -32601', async () => {
    const msg = await rpc('no/such/method', {});
    assert.equal(msg.error.code, -32601);
  });

  await t.test('bad JSON on stdin returns -32700', async () => {
    const response = new Promise((resolve) => pending.set('null', resolve));
    mcp.stdin.write('{this is not json\n');
    const msg = await response;
    assert.equal(msg.error.code, -32700);
    assert.equal(msg.id, null);
  });
});
