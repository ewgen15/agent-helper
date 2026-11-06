// Figma selection server: HTTP endpoint for the Figma plugin + MCP stdio server.
// stdout is reserved for MCP JSON-RPC; all logs go to stderr.
import http from 'node:http';
import crypto from 'node:crypto';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3846;
const BODY_LIMIT = 100 * 1024;
const ALLOWED_ORIGINS = new Set(['https://www.figma.com']);
const PROTOCOL_VERSION = '2024-11-05';

const log = (...args) => console.error('[figma-selection]', ...args);

let TOKEN = process.env.FIGMA_SELECTION_TOKEN || '';
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString('hex');
  log(`FIGMA_SELECTION_TOKEN is not set. Generated token: ${TOKEN}`);
}

// Latest selection received from the Figma plugin.
let latest = null; // { fileKey: string | null, nodes: [{id, name, type}], receivedAt }

// ---------- HTTP ----------

function originAllowed(origin) {
  return origin === undefined || origin === 'null' || ALLOWED_ORIGINS.has(origin);
}

function corsHeaders(origin) {
  if (origin === 'null' || ALLOWED_ORIGINS.has(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return {};
}

function tokenOk(provided) {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateSelection(d) {
  if (!d || typeof d !== 'object') return 'body must be a JSON object';
  // fileKey may be a non-empty string, or null/missing when the plugin cannot read figma.fileKey.
  if (d.fileKey !== undefined && d.fileKey !== null && (typeof d.fileKey !== 'string' || !d.fileKey)) {
    return 'fileKey must be a non-empty string or null';
  }
  if (!Array.isArray(d.nodes)) return 'nodes must be an array';
  for (const n of d.nodes) {
    if (!n || typeof n.id !== 'string' || typeof n.name !== 'string' || typeof n.type !== 'string') {
      return 'each node needs string id, name, type';
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);

  const send = (status, body, extra = {}) => {
    const headers = { ...cors, ...extra };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    res.writeHead(status, headers);
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  const preflight = (methods) => {
    res.writeHead(204, {
      ...cors,
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'Content-Type, x-token',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  };

  const pathname = new URL(req.url, `http://${HOST}`).pathname;
  // /health is polled every few seconds, so it never logs (not even rejected origins).
  const quiet = pathname === '/health';

  if (!originAllowed(origin)) {
    req.resume();
    if (!quiet) log(`403 origin ${origin}`);
    return send(403, { error: 'forbidden origin' }, { Connection: 'close' });
  }

  if (quiet) {
    req.resume();
    if (req.method === 'OPTIONS') return preflight('GET, OPTIONS');
    if (req.method !== 'GET') {
      return send(405, { error: 'method not allowed' }, { Allow: 'GET, OPTIONS' });
    }
    // Never echoes the token or the stored selection.
    return send(200, { ok: true, authorized: tokenOk(req.headers['x-token']) });
  }

  if (pathname !== '/selection') {
    req.resume();
    return send(404, { error: 'not found' });
  }

  if (req.method === 'OPTIONS') {
    req.resume();
    return preflight('POST, OPTIONS');
  }

  if (req.method !== 'POST') {
    req.resume();
    return send(405, { error: 'method not allowed' }, { Allow: 'POST, OPTIONS' });
  }

  if (!tokenOk(req.headers['x-token'])) {
    req.resume();
    log('401 bad or missing x-token');
    return send(401, { error: 'unauthorized' });
  }

  const chunks = [];
  let size = 0;
  let rejected = false;

  req.on('data', (chunk) => {
    if (rejected) return;
    size += chunk.length;
    if (size > BODY_LIMIT) {
      rejected = true;
      chunks.length = 0;
      log('413 body too large');
      send(413, { error: 'payload too large' }, { Connection: 'close' });
      return;
    }
    chunks.push(chunk);
  });

  req.on('error', (err) => log('request error:', err.message));

  req.on('end', () => {
    if (rejected) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(400, { error: 'invalid JSON' });
    }
    const problem = validateSelection(data);
    if (problem) return send(400, { error: problem });

    latest = {
      fileKey: data.fileKey ?? null,
      nodes: data.nodes.map(({ id, name, type }) => ({ id, name, type })),
      receivedAt: new Date().toISOString(),
    };
    log(`stored ${latest.nodes.length} node(s) from file ${latest.fileKey ?? '(no fileKey)'}`);
    send(200, { ok: true, count: latest.nodes.length, receivedAt: latest.receivedAt });
  });
});

server.on('error', (err) => {
  log(`HTTP server error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`HTTP listening on http://${HOST}:${PORT}/selection`);
});

// ---------- MCP over stdio ----------

const SERVER_INFO = { name: 'figma-selection', version: '0.1.0' };

const TOOL = {
  name: 'get_figma_selection',
  description: 'Returns the most recent Figma selection sent by the Figma plugin.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

function selectionText() {
  if (!latest || latest.nodes.length === 0) return 'Немає виділення';
  const lines = latest.nodes.map((n) => `${n.id} ${JSON.stringify(n.name)} (${n.type})`);
  return ['Figma nodes:', ...lines].join('\n');
}

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleMessage(msg) {
  const { id, method, params } = msg;
  if (!method) return; // response from client, nothing to do
  const isRequest = id !== undefined && id !== null;
  if (!isRequest) return; // notification (e.g. notifications/initialized)

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: [TOOL] });
    case 'tools/call':
      if (params?.name !== TOOL.name) {
        return fail(id, -32602, `Unknown tool: ${params?.name}`);
      }
      return reply(id, { content: [{ type: 'text', text: selectionText() }] });
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

function processLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, 'Parse error');
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return fail(null, -32600, 'Invalid Request');
  }
  handleMessage(msg);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) processLine(line);
  }
});

process.stdin.on('end', () => {
  const rest = buffer.trim();
  if (rest) processLine(rest);
  log('MCP stdin closed, shutting down');
  server.close();
  server.closeAllConnections?.();
});

process.on('uncaughtException', (err) => {
  log('uncaught exception:', err.stack || err.message);
});
