const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { OperationsTelemetry } = require('../operations-telemetry');

test('operations telemetry bounds raw history and separates heartbeat from reports', () => {
  const telemetry = new OperationsTelemetry({ maxRecent: 2, maxRawChars: 8 });
  telemetry.notePageView();
  telemetry.noteIncoming({ type: 'Heartbeat', satellite_id: 57, satellite_prn: 185, serial_connected: true }, '{}', { now: 100 });
  telemetry.noteIncoming({ type: 'A' }, '123456789', { now: 110 });
  telemetry.noteIncoming({ type: 'B' }, '{}', { now: 120 });
  telemetry.noteIncoming({ type: 'C' }, '{}', { now: 130 });
  const data = telemetry.snapshot(140);
  assert.equal(data.pageViewsSinceStart, 1);
  assert.equal(data.ingestCountSinceStart, 4);
  assert.equal(data.lastHeartbeatAt, 100);
  assert.equal(data.serialConnected, true);
  assert.deepEqual(data.recent.map((r) => r.type), ['C', 'B']);
  assert.equal(data.satellites[0].name, 'みちびき4号機');
  const truncated = new OperationsTelemetry({ maxRawChars: 8 });
  truncated.noteIncoming({ type: 'A' }, '123456789', { now: 100 });
  assert.equal(truncated.rawSnapshot()[0].rawJson, '12345678');
  assert.equal(truncated.rawSnapshot()[0].truncated, true);
  assert.equal('rawJson' in truncated.snapshot().recent[0], false);
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(t, extraEnv = {}) {
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzss-operations-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), LOCAL_STATE_ONLY: 'true', QZSS_LOCAL_STATE_DIR: stateDir, INGEST_TOKEN: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', ENABLE_WEB_ADMIN: 'false', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timeout);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 8000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('サーバー起動')) { clearTimeout(timeout); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`server exited ${code}: ${output}`)); });
  });
  return `http://127.0.0.1:${port}`;
}

test('local dashboard shows actual device, heartbeat and report data without secrets', async (t) => {
  const base = await startServer(t);
  const page = await fetch(`${base}/operations`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /受信・配信の運用状況/);
  await (await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) })).arrayBuffer();
  const status = await fetch(`${base}/device/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: 'qzss01', temperature_c: 49.4, git_commit_pi: 'abc123', secret: 'never-expose' }),
  });
  assert.equal(status.status, 200);
  await status.arrayBuffer();
  for (const report of [
    { type: 'Heartbeat', satellite_id: 57, satellite_prn: 185, serial_connected: true },
    { type: 'QzssDcReportJmaFlood', satellite_id: 61, satellite_prn: 189, disaster_category: '洪水', raw: 'abc' },
  ]) {
    const response = await fetch(`${base}/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
    assert.equal(response.status, 204);
    await response.arrayBuffer();
  }
  const response = await fetch(`${base}/api/operations`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.ok(data.pageViewsSinceStart >= 1);
  assert.equal(data.devices[0].deviceId, 'qzss01');
  assert.equal(data.devices[0].temperatureC, 49.4);
  assert.equal(JSON.stringify(data).includes('never-expose'), false);
  assert.equal(data.serialConnected, true);
  assert.equal(data.satellites.length, 2);
  assert.equal(data.recent[0].type, 'QzssDcReportJmaFlood');
  assert.equal('rawJson' in data.recent[0], false);
  const raw = await (await fetch(`${base}/api/operations/raw`)).json();
  assert.equal(raw.recent[0].rawJson.includes('"raw":"abc"'), true);
});

test('cloud service does not expose operations without admin login', async (t) => {
  const base = await startServer(t, { K_SERVICE: 'qzss-map' });
  assert.equal((await fetch(`${base}/operations`)).status, 404);
  assert.equal((await fetch(`${base}/api/operations`)).status, 404);
  assert.equal((await fetch(`${base}/api/operations/raw`)).status, 404);
});
