const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Manager } = require('../public/lalert-display');

test('一覧はキオスクと専用配信画面だけに限定する', () => {
  const source = fs.readFileSync(require.resolve('../public/main.js'), 'utf8');
  const start = source.indexOf('const lalertFullscreenEligible =');
  const end = source.indexOf('const lalertManager =', start);
  const expression = source.slice(start, end).replace('const lalertFullscreenEligible =', '').trim().replace(/;$/, '');
  const eligible = (hostname, localKiosk, device = null) => vm.runInNewContext(expression, {
    IS_LOCAL_KIOSK: localKiosk, LOCKED_DEVICE_ID: device,
    location: { hostname, search: '?stream=1' },
  });
  assert.equal(eligible('localhost', true), true);
  assert.equal(eligible('oracle-review.eq.shum10.com', false), true);
  assert.equal(eligible('eq.shum10.com', false, 'qzss01'), false);
  assert.equal(eligible('eq.shum10.com', false), false);
});

function fixture(index = 1, extra = {}) {
  return { type: 'QzssDcxLAlert', a1_message_type: 'Alert', a4_hazard_type: 'Flood',
    a5_severity: 'Severe', ex1_target_area_code_raw: 12000 + index,
    ex1_target_area_ja: `地域${index}`, a11_japanese_library_ja: `避難情報${index}`,
    a8_hazard_duration: 'Duration < 6H', ...extra };
}
function harness(fullscreenEligible = false) {
  let at = 100000;
  const manager = new Manager({ now: () => at, fullscreenEligible });
  return { manager, advance: ms => { at += ms; manager.tick(); }, now: () => at };
}

test('訓練・手動テストを除外し，深刻度と受信時刻で並べる', () => {
  const h = harness();
  assert.equal(h.manager.receive(fixture(1, { report_classification_no: 7 })), false);
  assert.equal(h.manager.receive(fixture(2, { a1_message_type: 'Test' })), false);
  assert.equal(h.manager.receive(fixture(3, { is_test_data: true })), false);
  assert.equal(h.manager.receive(fixture(4, { a5_severity: 'Moderate' })), true);
  h.advance(1000);
  h.manager.receive(fixture(5, { a5_severity: 'Severe' }));
  h.advance(1000);
  h.manager.receive(fixture(6, { a5_severity: 'Extreme' }));
  assert.deepEqual(h.manager.sorted().map(record => record.areaName), ['地域6', '地域5', '地域4']);
});

test('同じ地域の更新は置換し，解除は10秒だけ表示して消す', () => {
  const h = harness();
  h.manager.receive(fixture(1));
  h.advance(3000);
  assert.equal(h.manager.receive(fixture(1)), false);
  assert.equal(h.manager.sorted()[0].receivedAt, 100000);
  h.manager.receive(fixture(1, { a11_japanese_library_ja: '更新' }));
  assert.equal(h.manager.records.size, 1);
  assert.equal(h.manager.sorted()[0].message, '更新');
  h.manager.receive(fixture(1, { a1_message_type: 'All Clear' }));
  assert.match(h.manager.sorted()[0].message, /【解除】/);
  h.advance(9999);
  assert.equal(h.manager.records.size, 1);
  h.advance(1);
  assert.equal(h.manager.records.size, 0);
});

test('受信・更新・解除を待たずに画面へ通知する', () => {
  let changes = 0;
  const manager = new Manager({ now: () => 100000, onChange: () => { changes++; } });
  manager.receive(fixture(1));
  assert.equal(changes, 1);
  manager.receive(fixture(1));
  assert.equal(changes, 1);
  manager.receive(fixture(1, { a11_japanese_library_ja: '更新' }));
  assert.equal(changes, 2);
  manager.receive(fixture(1, { a1_message_type: 'All Clear' }));
  assert.equal(changes, 3);
});

test('再送の経過時間と最長24時間のTTLを守る', () => {
  const h = harness();
  assert.equal(h.manager.receive(fixture(1, { replay_age_ms: 6 * 3600000 })), false);
  h.manager.receive(fixture(1, { replay_age_ms: 2 * 3600000 }));
  h.advance(4 * 3600000 - 1);
  assert.equal(h.manager.records.size, 1);
  h.advance(1);
  assert.equal(h.manager.records.size, 0);
});

test('5件は平穏30分，10件は5分，20件は1分後に一覧へ入る', () => {
  for (const [count, delay] of [[5, 30 * 60000], [10, 5 * 60000], [20, 60000]]) {
    const h = harness(true);
    for (let n = 0; n < count; n++) h.manager.receive(fixture(n));
    h.advance(delay - 1);
    assert.equal(h.manager.mode, 'map');
    h.advance(1);
    assert.equal(h.manager.mode, 'list');
  }
});

test('一覧は20秒で改ページし，15分後に地図へ戻り30分維持する', () => {
  const h = harness(true);
  for (let n = 0; n < 10; n++) h.manager.receive(fixture(n));
  h.advance(5 * 60000);
  assert.equal(h.manager.mode, 'list');
  h.advance(20000);
  assert.equal(h.manager.pageIndex, 1);
  h.advance(15 * 60000 - 20000);
  assert.equal(h.manager.mode, 'map');
  h.advance(30 * 60000 - 1);
  assert.equal(h.manager.mode, 'map');
  h.advance(1);
  assert.equal(h.manager.mode, 'list');
});

test('新たな災害は一覧を同期的に閉じ，一般Web版は一覧へ入らない', () => {
  const h = harness(true);
  for (let n = 0; n < 5; n++) h.manager.receive(fixture(n));
  h.advance(30 * 60000);
  assert.equal(h.manager.mode, 'list');
  h.manager.setDisasterActive(true);
  assert.equal(h.manager.mode, 'map');
  h.advance(3600000);
  assert.equal(h.manager.mode, 'map');
  h.manager.setDisasterActive(false);
  h.advance(30 * 60000);
  assert.equal(h.manager.mode, 'list');
  const web = harness(false);
  for (let n = 0; n < 20; n++) web.manager.receive(fixture(n));
  web.advance(3600000);
  assert.equal(web.manager.mode, 'map');
});
