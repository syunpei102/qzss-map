const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ashIssueKey, ashNotificationBody } = require('../ash-notification');

const base = {
  disaster_category_no: 9,
  volcano_name: '桜島',
  volcano_name_raw: 406,
  activity_time: '2026-10-28T02:58:00',
  report_time: '2026-10-28T03:21:00',
};

test('ash fragments of the same issue share a notification key and body', () => {
  const first = { ...base, local_governments_raw: [46201], ash_fall_warning_codes: ['少量'] };
  const second = { ...base, local_governments_raw: [46214], ash_fall_warning_codes: ['やや多量'] };
  assert.equal(ashIssueKey(first), ashIssueKey(second));
  assert.equal(ashNotificationBody(first), ashNotificationBody(second));
  assert.match(ashNotificationBody(first), /桜島/);
});

test('new issues, volcanoes and training are independent notifications', () => {
  const key = ashIssueKey(base);
  for (const changed of [
    { report_time: '2026-10-28T04:21:00' },
    { activity_time: '2026-10-28T03:58:00' },
    { volcano_name_raw: 407 },
    { report_classification_no: 7 },
    { is_test_data: true },
  ]) assert.notEqual(ashIssueKey({ ...base, ...changed }), key);
});

test('seven fragments send one push; a new issue and cancellation each send once', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('function notificationUnits(report)');
  const end = source.indexOf('// 現在「表示中」とみなせる重要な通報', start);
  assert.ok(start > 0 && end > start);
  const payloads = [];
  const context = {
    ashIssueKey, ashNotificationBody,
    notifiedUnitsByKey: new Map(), NOTIFIED_KEY_LIMIT: 500,
    NOTIFY_REMEMBER_MS: 6 * 60 * 60 * 1000,
    pushSubscriptions: new Map([['one', {}]]),
    shouldNotify: () => true,
    isEndSignal: r => r.information_type_no === 2,
    notificationBodyFor: r => r.information_type_no === 2
      ? `解除: ${ashNotificationBody(r)}` : ashNotificationBody(r),
    notificationTitleFor: () => '降灰予報',
    guards: { notificationTag: key => key, earthquakeNotificationKey: () => 'n:eq' },
    webpush: { sendNotification: (_sub, payload) => { payloads.push(JSON.parse(payload)); return Promise.resolve(); } },
    persistPushSubscriptions: () => {},
    console,
  };
  const send = vm.runInNewContext(`${source.slice(start, end)}\nsendPushNotifications`, context);
  for (let i = 0; i < 7; i++) send({ ...base, local_governments_raw: [46201 + i] });
  assert.equal(payloads.length, 1);
  send({ ...base, report_time: '2026-10-28T04:21:00' });
  assert.equal(payloads.length, 2);
  send({ ...base, report_time: '2026-10-28T04:21:00', information_type_no: 2 });
  send({ ...base, report_time: '2026-10-28T04:21:00', information_type_no: 2 });
  assert.equal(payloads.length, 3);
  assert.match(payloads[2].body, /解除/);
});
