const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const WebSocket = require('ws');

async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(() => resolve(port));
    });
  });
}

async function startServer(port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), LOCAL_STATE_ONLY: 'true', INGEST_TOKEN: 'status-test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`startup timeout: ${output}`)), 15000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('サーバー起動')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
  });
  return child;
}

async function ingest(port, report) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(report);
    const req = http.request({
      host: '127.0.0.1', port, path: '/ingest', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Api-Key': 'status-test-token' },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
}

test('new WebSocket clients immediately receive the latest receiver state and its actual age', async (t) => {
  const port = await freePort();
  const child = await startServer(port);
  t.after(() => child.kill('SIGTERM'));
  assert.equal(await ingest(port, { type: 'Heartbeat', serial_connected: true, satellite_id: 57, satellite_prn: 185 }), 204);
  const snapshot = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('receiver snapshot timeout')); }, 5000);
    ws.once('message', (data) => { clearTimeout(timer); ws.close(); resolve(JSON.parse(data)); });
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
  assert.equal(snapshot.type, 'ReceiverStatus');
  assert.equal(snapshot.serial_connected, true);
  assert.equal(snapshot.satellite_id, 57);
  assert.ok(snapshot.ageMs >= 0 && snapshot.ageMs < 5000);
});
