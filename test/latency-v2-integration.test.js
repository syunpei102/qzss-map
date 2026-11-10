const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

async function availablePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('v2 ingest to websocket to timing history preserves local intervals', { timeout: 15000 }, async () => {
  const port = await availablePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzss-latency-v2-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, LOCAL_STATE_ONLY: 'true', QZSS_LOCAL_STATE_DIR: stateDir,
      PORT: String(port), HOST: '127.0.0.1', INGEST_TOKEN: '' },
    stdio: 'ignore',
  });
  let ws;
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
      try { ready = (await fetch(`${base}/api/latency-history`)).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'local server started');
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const message = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket timeout')), 3000);
      ws.on('message', data => {
        const report = JSON.parse(data);
        if (report.type !== 'LatencyIntegrationProbe') return;
        clearTimeout(timeout);
        resolve(report);
      });
    });
    const response = await fetch(`${base}/ingest`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'LatencyIntegrationProbe', is_test_data: true,
        client_timestamps: { schema_version: 2, receiver_decode_ms: 4.25 } }) });
    assert.equal(response.status, 204);
    const report = await message;
    assert.equal(report.client_timestamps.schema_version, 2);
    assert.equal(report.client_timestamps.receiver_decode_ms, 4.25);
    assert.ok(report.client_timestamps.server_processing_ms >= 0);
    assert.equal(report.client_timestamps.t2_server_received_ms, undefined);
    const timingResponse = await fetch(`${base}/client-timing`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...report.client_timestamps, client_processing_ms: 5,
        client_visual_ready_ms: 30, reportKey: 'dcr:ab12:2', isTestData: true }) });
    assert.equal(timingResponse.status, 204);
    const history = await (await fetch(`${base}/api/latency-history`)).json();
    assert.equal(history.length, 1);
    assert.equal(history[0].schemaVersion, 2);
    assert.ok(Math.abs(history[0].measuredMs - (34.25 + report.client_timestamps.server_processing_ms)) < 1e-9);
    const duplicate=await fetch(`${base}/client-timing`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...report.client_timestamps,client_processing_ms:3,client_visual_ready_ms:null,reportKey:'dcr:ab12:2',isTestData:true,client_version:'1.13.0',display_result:{status:'skipped',reason:'training-off'}})});
    assert.equal(duplicate.status,204);
    const updated=await(await fetch(`${base}/api/latency-history`)).json();
    assert.equal(updated.length,1);
    assert.equal(updated[0].measuredMs,history[0].measuredMs);
    assert.deepEqual(updated[0].displayObservations[0].displayResult,{status:'skipped',reason:'training-off'});
    assert.equal(updated[0].displayObservations[0].clientVersion,'1.13.0');

  } finally {
    ws?.close();
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
