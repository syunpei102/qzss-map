#!/usr/bin/env node
// 通報受信からpush送信開始までのサーバー内所要時間を比較する．
// 実際のpush事業者への通信や端末表示時間は含まない．
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { createSerialQueue } = require('../persist-queue');
const { updateActiveReports, pruneExpiredReports, isSupersededEarthquakeReport } = require('../report-state');

function extract(source, begin, end) {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start);
  if (start < 0 || stop < 0) throw new Error(`server.jsの関数を抽出できません: ${begin}`);
  return source.slice(start, stop);
}

async function main() {
  const source = fs.readFileSync(process.env.QZSS_BENCH_SERVER || path.join(__dirname, '..', 'server.js'), 'utf8');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzss-notify-bench-'));
  const samples = [];
  const report = { type: 'QzssDcReportJmaEarthquakeEarlyWarning', disaster_category_no: 1, report_time: new Date().toISOString(), occurrence_time_of_earthquake: new Date().toISOString(), description: '緊急地震速報'.repeat(100) };
  const activeReports = Array.from({ length: 40 }, (_, i) => ({ report: { type: 'Other', disaster_category_no: 100 + i, report_time: new Date().toISOString(), description: '警報'.repeat(400) }, receivedAt: Date.now() }));
  const gcsSaveQueue = createSerialQueue();
  const localSaveQueue = createSerialQueue();
  const context = {
    fs, LOCAL_STATE_ONLY: false, LOCAL_STATE_DIR: tempDir,
    localStatePath: name => path.join(tempDir, name),
    gcsSaveQueue, localSaveQueue,
    gcsStorage: { bucket: () => ({ file: () => ({ save: async () => {} }) }) },
    REGION_STATE_BUCKET: 'benchmark', ACTIVE_REPORTS_STATE_FILE: 'active_reports.json',
    activeReports, console: { log: () => {}, error: () => {}, warn: () => {} },
    pushSubscriptions: new Map([['one', {}]]),
    notifiedUnitsByKey: new Map(), NOTIFIED_KEY_LIMIT: 500, NOTIFY_REMEMBER_MS: 6 * 60 * 60 * 1000,
    shouldNotify: () => true,
    notificationTitleFor: () => '緊急地震速報',
    notificationBodyFor: item => `地震情報 ${item.seq}`,
    guards: { earthquakeNotificationKey: () => 'n:earthquake', notificationTag: () => 'earthquake' },
    webpush: { sendNotification: () => { samples.push(performance.now() - context.startedAt); return Promise.resolve(); } },
    persistPushSubscriptions: () => {},
    isDuplicateReport: () => false, isEndSignal: () => false,
    isReplayable: () => true, isSupersededEarthquakeReport,
    updateActiveReports, pruneStaleActiveReports: () => { context.activeReports = pruneExpiredReports(context.activeReports, Date.now()); },
    broadcast: () => {},
  };
  const code = [
    extract(source, 'function persistJson(', 'const gcsSaveQueue ='),
    extract(source, 'function persistActiveReports()', '// 管理者パスワード'),
    extract(source, 'function notificationUnits(report)', '// 現在「表示中」とみなせる重要な通報'),
    extract(source, 'function handleIncomingLine(line)', '// ラズパイなど現地の受信機'),
    'handleIncomingLine',
  ].join('\n');
  const handleIncomingLine = vm.runInNewContext(code, context);
  try {
    for (let i = 0; i < 520; i++) {
      const line = JSON.stringify({ ...report, seq: i });
      context.startedAt = performance.now();
      handleIncomingLine(line);
    }
    await Promise.all([gcsSaveQueue.drain(), localSaveQueue.drain()]);
    const values = samples.slice(20).sort((a, b) => a - b);
    const percentile = p => values[Math.floor((values.length - 1) * p)].toFixed(3);
    console.log(JSON.stringify({ samples: values.length, activeReports: context.activeReports.length, stateBytes: Buffer.byteLength(JSON.stringify(context.activeReports)), medianMs: percentile(0.5), p95Ms: percentile(0.95) }));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
