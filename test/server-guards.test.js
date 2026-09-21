const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createSerialQueue, createDebouncedTask } = require('../persist-queue');
const g = require('../request-guards');
const { DeviceCommandQueue } = require('../device-commands');
const PushDisplay = require('../public/push-display');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('serial queue runs same-file saves in call order even if later ones are faster', async () => {
  const enqueue = createSerialQueue();
  const order = [];
  const first = deferred();
  const p1 = enqueue('a.json', async () => { await first.promise; order.push(1); });
  const p2 = enqueue('a.json', async () => { order.push(2); });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(order, [], 'second save waits for the first');
  first.resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2]);
});
test('serial queue continues after a failure and does not block other files', async () => {
  const enqueue = createSerialQueue();
  const order = [];
  const p1 = enqueue('a', async () => { throw new Error('boom'); });
  const p2 = enqueue('a', async () => { order.push('a2'); });
  const blocker = deferred();
  enqueue('b', () => blocker.promise);
  const p3 = enqueue('c', async () => { order.push('c'); });
  await assert.rejects(p1, /boom/);
  await Promise.all([p2, p3]);
  assert.deepEqual(order.sort(), ['a2', 'c']);
  blocker.resolve();
});
test('serial queue drain waits for every pending save', async () => {
  const queue = createSerialQueue();
  let release;
  let completed = false;
  queue('state.json', () => new Promise(resolve => { release = () => { completed = true; resolve(); }; }));
  await new Promise(resolve => setImmediate(resolve));
  const drained = queue.drain();
  assert.equal(completed, false);
  release();
  await drained;
  assert.equal(completed, true);
});
test('debounced persistence coalesces bursts and honours max wait', () => {
  let calls = 0;
  const timers = [];
  let t = 0;
  const d = createDebouncedTask(() => { calls++; }, {
    delayMs: 30, maxWaitMs: 100, now: () => t,
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimer: () => {},
  });
  d.schedule(); t = 20; d.schedule(); t = 90; d.schedule();
  assert.equal(timers.at(-1).ms, 10, 'wait shortened so first schedule + maxWait is respected');
  assert.equal(calls, 0);
  d.flush();
  assert.equal(calls, 1);
  assert.equal(d.pending(), false);
});

test('listen config: local mode is loopback by default, cloud is all interfaces', () => {
  assert.equal(g.resolveListenConfig({ LOCAL_STATE_ONLY: 'true' }).host, '127.0.0.1');
  assert.equal(g.resolveListenConfig({}).host, '0.0.0.0');
  assert.equal(g.resolveListenConfig({ PORT: '9000' }).port, '9000');
});
test('listen config: exposing local mode needs a token or an explicit danger flag', () => {
  const base = { LOCAL_STATE_ONLY: 'true', HOST: '0.0.0.0' };
  assert.match(g.resolveListenConfig(base).error, /INGEST_TOKEN/);
  assert.equal(g.resolveListenConfig({ ...base, INGEST_TOKEN: 'x' }).error, undefined);
  assert.equal(g.resolveListenConfig({ ...base, QZSS_ALLOW_INSECURE_LAN: 'true' }).error, undefined);
});
test('server refuses to start when exposing local mode without auth', () => {
  const r = spawnSync(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, LOCAL_STATE_ONLY: 'true', HOST: '0.0.0.0', INGEST_TOKEN: '', PORT: '0' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /INGEST_TOKEN/);
});
test('tokenless requests are accepted only from loopback unless explicitly allowed', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(g.mayBypassAuth(a, {}), true);
  assert.equal(g.mayBypassAuth('192.168.1.20', {}), false);
  assert.equal(g.mayBypassAuth('192.168.1.20', { QZSS_ALLOW_INSECURE_LAN: 'true' }), true);
});

test('rate limiter blocks over the limit and recovers after the window', () => {
  let now = 0;
  const allow = g.createRateLimiter({ windowMs: 1000, max: 2, now: () => now });
  assert.deepEqual([allow('ip'), allow('ip'), allow('ip'), allow('other')], [true, true, false, true]);
  now = 1000;
  assert.equal(allow('ip'), true);
});
test('rate limiter bounds tracked keys', () => {
  const allow = g.createRateLimiter({ windowMs: 1000, max: 5, maxKeys: 2, now: () => 0 });
  assert.equal(allow('a'), true);
  assert.equal(allow('b'), true);
  assert.equal(allow('c'), false);
});

const goodSub = () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTp', auth: 'tBHItJI5svbpez7KI4CCXg' } });
test('push subscription: accepts a browser subscription and strips extra fields', () => {
  const r = g.validatePushSubscription({ ...goodSub(), junk: 'x'.repeat(10000) });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.subscription).sort(), ['endpoint', 'expirationTime', 'keys']);
});
test('push subscription: rejects malformed, oversized and internal endpoints', () => {
  const bad = [
    null, [], {}, { ...goodSub(), endpoint: 'http://fcm.googleapis.com/x' },
    { ...goodSub(), endpoint: 'https://127.0.0.1/x' }, { ...goodSub(), endpoint: 'https://localhost/x' },
    { ...goodSub(), endpoint: 'https://metadata.internal/x' }, { ...goodSub(), endpoint: 'https://u:p@fcm.googleapis.com/x' },
    { ...goodSub(), endpoint: 'https://fcm.googleapis.com:8443/x' },
    { ...goodSub(), endpoint: 'https://fcm.googleapis.com/' + 'a'.repeat(3000) },
    { ...goodSub(), keys: { p256dh: 'x', auth: 'y' } }, { ...goodSub(), keys: undefined },
    { ...goodSub(), keys: { p256dh: '!!!!!!!!!!', auth: 'tBHItJI5svbpez7KI4CCXg' } },
    { ...goodSub(), expirationTime: 'soon' },
  ];
  for (const b of bad) assert.equal(g.validatePushSubscription(b).ok, false, JSON.stringify(b)?.slice(0, 80));
});

test('client timing: valid input is computed, NaN/missing/out-of-range are dropped', () => {
  const ok = { t0_received_ms: 1000, t1_decoded_ms: 1010, t2_server_received_ms: 1050, t3_dispatched_ms: 1060, client_processing_ms: 30 };
  assert.deepEqual(g.validateClientTiming(ok), { decodeMs: 10, networkMs: 40, dispatchPrepMs: 10, renderMs: 30, totalMs: 90, reportSummary: null, isTestData: false });
  for (const patch of [{ t0_received_ms: NaN }, { t1_decoded_ms: undefined }, { client_processing_ms: -1 }, { client_processing_ms: 1e12 },
    { t2_server_received_ms: 1e15 }, { t3_dispatched_ms: '5' }, { t0_received_ms: 0 }]) {
    assert.equal(g.validateClientTiming({ ...ok, ...patch }), null, JSON.stringify(patch));
  }
  assert.equal(g.validateClientTiming(null), null);
  assert.equal(g.validateClientTiming({ ...ok, reportSummary: 'x'.repeat(999) }).reportSummary.length, 200);
});

test('notification tag: earthquakes replace per event, area types never overwrite others', () => {
  assert.equal(g.notificationTag('n:eq|time:T', 'A', true), g.notificationTag('n:eq|time:T', 'B', true));
  assert.notEqual(g.notificationTag('n:eq|time:T1', 'A', true), g.notificationTag('n:eq|time:T2', 'A', true));
  assert.notEqual(g.notificationTag('n:weather', '東京', false), g.notificationTag('n:weather', '大阪', false));
  assert.notEqual(g.notificationTag('n:tsunami', 'x', false), g.notificationTag('n:weather', 'x', false));
  assert.equal(g.notificationTag('n:weather', '東京', false), g.notificationTag('n:weather', '東京', false));
  assert.equal(g.notificationTag(null, 'x', false), undefined);
});
test('earthquake notification key uses every available identifier', () => {
  const base = { occurrence_time_of_earthquake: 'T', seismic_epicenter_raw: 1 };
  assert.equal(g.earthquakeNotificationKey(base), 'n:eq|time:T|epi:1');
  assert.notEqual(g.earthquakeNotificationKey(base), g.earthquakeNotificationKey({ ...base, seismic_epicenter_raw: 2 }));
  assert.notEqual(g.earthquakeNotificationKey(base), g.earthquakeNotificationKey({ ...base, occurrence_time_of_earthquake: 'T2' }));
  assert.equal(g.earthquakeNotificationKey({ occurrence_time_of_earthquake: 'T' }), 'n:eq|time:T');
  assert.equal(g.earthquakeNotificationKey({ seismic_epicenter_raw: 1 }), 'n:eq|epi:1');
});
test('service worker display: tag is passed through, absent tag never overwrites', () => {
  const withTag = PushDisplay.buildNotification({ title: 't', body: 'b', tag: 'n:eq|1' });
  assert.equal(withTag.options.tag, 'n:eq|1');
  assert.equal(withTag.options.renotify, true);
  const none = PushDisplay.buildNotification({ title: 't', body: 'b' });
  assert.equal('tag' in none.options, false);
  assert.notEqual(withTag.options.tag, 'qzss-alert');
  assert.equal(PushDisplay.parsePushData({ data: { json: () => { throw new Error('x'); } } }).title, '防災情報');
  assert.equal(PushDisplay.parsePushData({ data: { json: () => ({ title: 'T', tag: 'k' }) } }).tag, 'k');
});

test('device commands: response loss redelivers until acked; ack removes it', () => {
  let now = 0;
  const q = new DeviceCommandQueue({ now: () => now, newId: (() => { let i = 0; return () => `id${++i}`; })() });
  q.enqueue('d', 'reboot');
  assert.deepEqual(q.collect('d', { supportsAck: true }).map(c => c.id), ['id1']);
  assert.deepEqual(q.collect('d', { supportsAck: true }).map(c => c.id), ['id1'], 'not acked => redelivered');
  assert.deepEqual(q.collect('d', { supportsAck: true, ackedIds: ['id1'] }), []);
  assert.equal(q.list('d')[0].state, 'acked');
  assert.deepEqual(q.collect('d', { supportsAck: true }), []);
});
test('device commands: legacy devices get at-most-once delivery (no reboot loop)', () => {
  const q = new DeviceCommandQueue();
  q.enqueue('d', 'reboot');
  assert.equal(q.collect('d', {}).length, 1);
  assert.equal(q.collect('d', {}).length, 0);
  assert.equal(q.list('d')[0].state, 'sent_unconfirmed');
});
test('device commands: expiry, delivery cap, persistence across restart', () => {
  let now = 0;
  const q = new DeviceCommandQueue({ now: () => now, ttlMs: 1000, maxDeliveries: 2 });
  q.enqueue('d', 'force_update_check');
  q.collect('d', { supportsAck: true }); q.collect('d', { supportsAck: true });
  assert.deepEqual(q.collect('d', { supportsAck: true }), []);
  assert.equal(q.list('d')[0].state, 'failed');
  q.enqueue('d', 'reboot');
  const restarted = new DeviceCommandQueue({ now: () => now, ttlMs: 1000 });
  restarted.restore(JSON.parse(JSON.stringify(q.toJSON())));
  assert.equal(restarted.collect('d', { supportsAck: true }).length, 1, 'survives restart');
  now = 1000;
  assert.deepEqual(restarted.collect('d', { supportsAck: true }), []);
  assert.equal(restarted.list('d').at(-1).state, 'expired');
});
test('device commands: restore ignores unknown commands', () => {
  const q = new DeviceCommandQueue();
  q.restore({ d: [{ id: 'x', command: 'rm -rf', requestedAt: 1 }, 'junk'] });
  assert.equal(q.hasDevice('d'), false);
});
test('device commands: restore normalizes incomplete legacy records', () => {
  let now = 10;
  const q = new DeviceCommandQueue({ now: () => now, ttlMs: 100 });
  q.restore({ d: [{ id: 'x', command: 'reboot', requestedAt: 1 }] });
  const [record] = q.list('d');
  assert.equal(record.expiresAt, 101);
  assert.equal(record.deliveryCount, 0);
  assert.equal(record.state, 'pending');
  assert.equal(q.collect('d', { supportsAck: true }).length, 1);
  assert.equal(q.list('d')[0].deliveryCount, 1);
});
