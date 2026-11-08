const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createSerialQueue } = require('../persist-queue');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function extract(begin, end) {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start);
  assert.ok(start >= 0 && stop > start);
  return source.slice(start, stop);
}

for (const localOnly of [false, true]) {
  test(`${localOnly ? 'Pi' : 'Cloud Run'}: notification and persistence keep their intended order`, () => {
    const calls = [];
    const context = {
      LOCAL_STATE_ONLY: localOnly,
      activeReports: [],
      isDuplicateReport: () => false,
      isEndSignal: () => false,
      isReplayable: () => true,
      isSupersededEarthquakeReport: () => false,
      updateActiveReports: (_reports, report) => [{ report }],
      pruneStaleActiveReports: () => {},
      persistActiveReports: () => calls.push('persist'),
      broadcast: () => calls.push('broadcast'),
      sendPushNotifications: () => calls.push('push'),
      console,
    };
    const handle = vm.runInNewContext(`${extract('function handleIncomingLine(line)', '// ラズパイなど現地の受信機')}\nhandleIncomingLine`, context);
    handle(JSON.stringify({ type: 'Report', report_time: '2026-11-08T00:00:00' }));
    assert.deepEqual(calls, localOnly ? ['persist', 'broadcast', 'push'] : ['broadcast', 'push', 'persist']);
  });
}

test('Cloud Run local backup is asynchronous and retains the newest state', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzss-notify-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const localSaveQueue = createSerialQueue();
  const gcsSaveQueue = createSerialQueue();
  const gcsWrites = [];
  const context = {
    fs: {
      ...fs,
      mkdirSync: () => { throw new Error('unexpected sync mkdir'); },
      writeFileSync: () => { throw new Error('unexpected sync write'); },
    },
    LOCAL_STATE_ONLY: false,
    LOCAL_STATE_DIR: dir,
    localStatePath: name => path.join(dir, name),
    localSaveQueue, gcsSaveQueue,
    gcsStorage: { bucket: () => ({ file: () => ({ save: async json => { gcsWrites.push(JSON.parse(json)); } }) }) },
    REGION_STATE_BUCKET: 'test',
    console,
  };
  const persist = vm.runInNewContext(`${extract('function persistJson(', 'const gcsSaveQueue =')}\npersistJson`, context);
  persist('active_reports.json', { sequence: 1 }, { nonBlockingLocal: true });
  persist('active_reports.json', { sequence: 2 }, { nonBlockingLocal: true });
  await Promise.all([localSaveQueue.drain(), gcsSaveQueue.drain()]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'active_reports.json'), 'utf8')).sequence, 2);
  assert.deepEqual(gcsWrites.map(x => x.sequence), [1, 2]);
});

test('urgent push is submitted to all subscriptions immediately and completion waits for acceptance', async () => {
  const deferred = [];
  const seen = [];
  const context = {
    pushSubscriptions: new Map([['first', {}], ['second', {}]]),
    notificationGroupKey: () => 'n:earthquake',
    guards: { notificationTag: () => 'warning', earthquakeNotificationKey: () => 'event' },
    notificationTitleFor: () => '緊急地震速報',
    webpush: { sendNotification: (_sub, payload, options) => {
      seen.push({ payload: JSON.parse(payload), options });
      return new Promise(resolve => deferred.push(resolve));
    } },
    persistPushSubscriptions: () => {},
    console: { log: () => {}, error: () => {} },
  };
  const dispatch = vm.runInNewContext(`${extract('const inFlightPushes = new Set();', 'function sendPushNotifications(report)')}\ndispatchPush`, context);
  const pending = dispatch({ disaster_category_no: 1 }, '強い揺れに警戒');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].options.urgency, 'high');
  assert.equal(seen[0].options.TTL, 600);
  assert.equal(seen[0].payload.body, '強い揺れに警戒');
  let completed = false;
  pending.then(() => { completed = true; });
  deferred[0]();
  await Promise.resolve();
  assert.equal(completed, false);
  deferred[1]();
  await pending;
  assert.equal(completed, true);
});

test('temporary provider failure retries once and lets the receiver retry the report', async () => {
  let attempts = 0;
  let forgotten = false;
  const recentContentKeys = new Map([['packet', Date.now()]]);
  const context = {
    pushSubscriptions: new Map([['first', {}]]),
    notificationGroupKey: () => 'n:earthquake',
    reportContentKey: () => 'packet', recentContentKeys,
    guards: { notificationTag: () => 'warning' },
    notificationTitleFor: () => '緊急地震速報',
    webpush: { sendNotification: async () => { attempts++; throw { statusCode: 503 }; } },
    setTimeout: fn => { fn(); return 0; },
    persistPushSubscriptions: () => {},
    console: { log: () => {}, error: () => {} },
  };
  const dispatch = vm.runInNewContext(`${extract('const inFlightPushes = new Set();', 'function sendPushNotifications(report)')}\ndispatchPush`, context);
  const result = await dispatch({ disaster_category_no: 1 }, '強い揺れに警戒', () => { forgotten = true; });
  assert.equal(attempts, 2);
  assert.equal(forgotten, true);
  assert.equal(recentContentKeys.has('packet'), false);
  assert.equal(result.retryableFailure, true);
});

test('ingest keeps the request open until the push provider accepts', async () => {
  let handler;
  let accept;
  const calls = [];
  const context = {
    app: { post: (_path, fn) => { handler = fn; } },
    requireDeviceToken: () => ({ ok: true, deviceId: 'test' }),
    handleIncomingLine: () => new Promise(resolve => { accept = resolve; }),
    console: { log: () => {} },
  };
  vm.runInNewContext(extract('app.post("/ingest",', '// レイテンシ計測(T0受信〜T4描画完了)の履歴'), context);
  const res = { status: code => { calls.push(code); return { end: () => calls.push('end') }; } };
  const pending = handler({ body: { type: 'Report' } }, res, err => { throw err; });
  assert.deepEqual(calls, []);
  accept();
  await pending;
  assert.deepEqual(calls, [204, 'end']);
});

test('ingest returns 503 when every push attempt fails transiently', async () => {
  let handler;
  const context = {
    app: { post: (_path, fn) => { handler = fn; } },
    requireDeviceToken: () => ({ ok: true }),
    handleIncomingLine: async () => ({ accepted: 0, attempted: 1, retryableFailure: true }),
    console: { log: () => {} },
  };
  vm.runInNewContext(extract('app.post("/ingest",', '// レイテンシ計測(T0受信〜T4描画完了)の履歴'), context);
  const calls = [];
  const res = { status: code => { calls.push(code); return { json: body => calls.push(body.error) }; } };
  await handler({ body: { type: 'Report' } }, res, err => { throw err; });
  assert.deepEqual(calls, [503, 'push delivery temporarily unavailable']);
});
