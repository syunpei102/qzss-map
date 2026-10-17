const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'main.js'), 'utf8');
const start = source.indexOf('const HEARTBEAT_TIMEOUT_MS =');
const end = source.indexOf('setInterval(refreshStatusPill, 5000);', start);
assert.ok(start >= 0 && end > start);

function createStatusHarness(local = false) {
  let now = 100_000;
  const status = { textContent: '', className: '' };
  const satellite = { textContent: '' };
  const context = vm.createContext({
    IS_LOCAL_KIOSK: local,
    SATELLITE_NAMES: { 57: 'みちびき4号機', 61: 'みちびき3号機' },
    Date: { now: () => now },
    document: { getElementById: (id) => id === 'status' ? status : satellite },
    setInterval: () => {},
    nowTimeString: () => '09:00:00',
    console: { log: () => {} },
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    status,
    satellite,
    setNow: (value) => { now = value; },
    evaluate: (code) => vm.runInContext(code, context),
  };
}

test('public page does not claim a receiver is online before its first heartbeat', () => {
  const view = createStatusHarness();
  view.evaluate('wsConnectedAt = Date.now(); updateConnectionStatus("online")');
  assert.equal(view.status.textContent, '🟡 受信確認待ち');
  view.setNow(190_001);
  view.evaluate('refreshStatusPill()');
  assert.equal(view.status.textContent, '🔴 受信機オフライン');
});

test('receiver heartbeat identifies the latest seen satellite without inventing a reception time', () => {
  const view = createStatusHarness();
  view.evaluate('wsConnectedAt = Date.now(); updateConnectionStatus("online")');
  view.evaluate('noteReceiverHeartbeat({ satellite_id: 57, satellite_prn: 185, serial_connected: true })');
  assert.equal(view.status.textContent, '🟢 オンライン');
  assert.equal(view.satellite.textContent, '🛰️ 受信機が最後に確認した衛星: みちびき4号機');
  view.setNow(191_000);
  view.evaluate('refreshStatusPill()');
  assert.equal(view.status.textContent, '🔴 受信機オフライン');
  assert.equal(view.satellite.textContent, '');
});

test('fresh receiver snapshot is online immediately after opening the site', () => {
  const view = createStatusHarness();
  view.evaluate('wsConnectedAt = Date.now(); updateConnectionStatus("online")');
  view.evaluate('noteReceiverHeartbeat({ satellite_id: 61, satellite_prn: 189, serial_connected: true }, 20000)');
  assert.equal(view.status.textContent, '🟢 オンライン');
  assert.match(view.satellite.textContent, /みちびき3号機/);
  view.setNow(170_001);
  view.evaluate('refreshStatusPill()');
  assert.equal(view.status.textContent, '🔴 受信機オフライン');
});

test('serial disconnected heartbeat does not claim the receiver is online', () => {
  const view = createStatusHarness();
  view.evaluate('wsConnectedAt = Date.now(); updateConnectionStatus("online")');
  view.evaluate('noteReceiverHeartbeat({ serial_connected: false, satellite_id: 57 }, 1000)');
  assert.equal(view.status.textContent, '🔴 受信機の接続を確認できません');
  view.evaluate('noteReceiverHeartbeat({ serial_connected: true, satellite_id: 57 })');
  assert.equal(view.status.textContent, '🟢 オンライン');
});

test('local demo can show server connectivity without a receiver', () => {
  const view = createStatusHarness(true);
  view.evaluate('wsConnectedAt = Date.now(); updateConnectionStatus("online")');
  assert.equal(view.status.textContent, '🟢 オンライン');
});
