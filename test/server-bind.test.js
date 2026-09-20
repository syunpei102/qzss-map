const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`server startup timeout: ${output}`)), 5000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('サーバー起動')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited before ready (${code}): ${output}`));
    });
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
  });
}

// 子プロセスを確実に終了させる: SIGTERM→最大3秒待機→残っていればSIGKILL．
// stdio のパイプも閉じ，テストランナーが終了できるようにする．
async function stopChild(child, graceMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = new Promise((resolve) => {
    const h = setTimeout(() => resolve('timeout'), graceMs);
    exited.then(() => clearTimeout(h));
  });
  if ((await Promise.race([exited, timer])) === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
  child.stdout.destroy();
  child.stderr.destroy();
}

function requestStatus(host, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('timeout', () => req.destroy(new Error('request timeout')));
    req.once('error', reject);
  });
}

function nonLoopbackIpv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

test('LOCAL_STATE_ONLY defaults to loopback-only binding', async (t) => {
  const lanAddress = nonLoopbackIpv4();
  if (!lanAddress) return t.skip('non-loopback IPv4 address is unavailable');

  const port = await reservePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      LOCAL_STATE_ONLY: 'true',
      INGEST_TOKEN: '',
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stopChild(child));

  await waitForReady(child);
  assert.equal(await requestStatus('127.0.0.1', port), 200);
  await assert.rejects(requestStatus(lanAddress, port), /ECONNREFUSED|EHOSTUNREACH|request timeout/);
});
