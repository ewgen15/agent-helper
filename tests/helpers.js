'use strict';
// Shared helpers for the regression tests (node:test + node:assert only).
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server', 'index.js');

// Returns a free TCP port in 4100-4999 (never 3845/3846).
async function freePort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = 4100 + Math.floor(Math.random() * 900);
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('no free port found in 4100-4999');
}

// Spawns server/index.js and resolves once it logs that it is listening.
async function spawnServer(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(port), FIGMA_SELECTION_TOKEN: 'test', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes('HTTP listening')) {
        child.stderr.off('data', onData);
        resolve();
      }
    };
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`server exited early (${code}): ${stderr}`)));
  });
  return { child, port };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

// Minimal HTTP client using node:http (lets us set Origin, which fetch may forbid).
function httpRequest(port, { method = 'POST', path: urlPath = '/selection', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

const VALID_BODY = JSON.stringify({
  fileKey: 'abc123',
  nodes: [{ id: '1:2', name: 'Button', type: 'FRAME' }],
});

module.exports = { ROOT, SERVER_PATH, freePort, spawnServer, stopChild, httpRequest, VALID_BODY };
