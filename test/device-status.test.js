const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isDeviceOnline, DEVICE_OFFLINE_AFTER_MS, STATUS_REPORT_INTERVAL_MS } = require('../device-status');

const MIN = 60 * 1000;

test('offline threshold is 15 minutes: three 5-minute reports', () => {
  assert.equal(STATUS_REPORT_INTERVAL_MS, 5 * MIN);
  assert.equal(DEVICE_OFFLINE_AFTER_MS, 15 * MIN);
});

test('device stays online through one or two missed reports', () => {
  const t = 1_000_000_000;
  assert.equal(isDeviceOnline(t, t), true);
  assert.equal(isDeviceOnline(t, t + 5 * MIN), true);
  assert.equal(isDeviceOnline(t, t + 10 * MIN + 30_000), true); // 2回失敗＋遅延
  assert.equal(isDeviceOnline(t, t + 15 * MIN - 1), true);
});

test('boundary: exactly 15 minutes without a report is offline', () => {
  const t = 1_000_000_000;
  assert.equal(isDeviceOnline(t, t + 15 * MIN), false);
  assert.equal(isDeviceOnline(t, t + 16 * MIN), false);
  assert.equal(isDeviceOnline(t, t + 130 * MIN), false); // 旧閾値でもオフライン
});

test('offline to online transition happens on the next report', () => {
  const lastReport = 1_000_000_000;
  const now = lastReport + 20 * MIN;
  assert.equal(isDeviceOnline(lastReport, now), false);
  assert.equal(isDeviceOnline(now, now + 1000), true);
});

test('invalid timestamps are offline, future timestamps are online', () => {
  const now = 1_000_000_000;
  for (const bad of [undefined, null, NaN, 'x']) assert.equal(isDeviceOnline(bad, now), false);
  assert.equal(isDeviceOnline(now + MIN, now), true);
});

test('custom threshold is honoured', () => {
  assert.equal(isDeviceOnline(0, 999, 1000), true);
  assert.equal(isDeviceOnline(0, 1000, 1000), false);
});

test('server.js uses the tested module and the Docker image ships it', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /require\("\.\/device-status"\)/);
  assert.match(server, /online: isDeviceOnline\(d\.receivedAt, now\)/);
  assert.doesNotMatch(server, /状態報告\(1時間おき\)/);
  assert.doesNotMatch(server, /130 \* 60 \* 1000/);
  const docker = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(docker, /device-status\.js/);
});
