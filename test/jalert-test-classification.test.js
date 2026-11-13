const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TrainingReportFilter = require('../public/training-report-filter');
const ReportTtl = require('../public/report-ttl');
const { pruneExpiredReports, storageKey } = require('../report-state');

// 本番で2026年11月11日（水）11:00に受信した電文の判定関連フィールド．
const captured = {
  type: 'QzssDcxJAlert', a1_message_type: 'Alert',
  a4_hazard_type: 'Test alert', a5_severity: 'Unknown',
  a11_japanese_library_ja: 'これは、Jアラートのテストです。',
  a8_hazard_duration: 'Unknown', ex9_target_area_list_ja: ['東京都'],
};
function load(file, name, end, context) {
  const source = fs.readFileSync(require.resolve(file), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  const stop = source.indexOf(end, start);
  assert.ok(start >= 0 && stop > start);
  return vm.runInNewContext(`${source.slice(start, stop)}; ${name}`, context);
}

test('captured Alert / Test alert and legacy Test are official training; real alerts stay live', () => {
  for (const report of [captured, { ...captured, a1_message_type: 'Test', a4_hazard_type: 'Missile' }]) {
    assert.equal(TrainingReportFilter.isOfficialTraining(report), true);
    assert.equal(TrainingReportFilter.shouldProcess(report), true);
  }
  assert.equal(TrainingReportFilter.isOfficialTraining({ ...captured, a4_hazard_type: 'Missile' }), false);
  assert.equal(TrainingReportFilter.isOfficialTraining({ ...captured, type: 'Other' }), false);
  assert.equal(TrainingReportFilter.isOfficialTraining({ ...captured, a4_hazard_type: 'Missile', description: 'Test alert' }), false);
});

test('actual notification gate blocks captured test only when training is OFF', () => {
  for (const enabled of [false, true]) {
    const notify = load('../server.js', 'shouldNotify', '// public/main.jsの同名関数', {
      NOTIFICATION_BACKEND_URL: "", PUSH_ENABLED: true, InformationSettings: { isEnabled: () => true }, informationCategorySettings: {},
      isStaleForNotification: () => false, globalShowTrainingBroadcasts: enabled,
      TrainingReportFilter, globalLalertEnabled: false,
    });
    assert.equal(notify(captured), enabled);
    assert.equal(notify({ ...captured, a4_hazard_type: 'Missile' }), true);
  }
});

test('actual rendering gate blocks training OFF and expired replays, allowing live alerts', () => {
  for (const enabled of [false, true]) {
    let rendered = 0;
    const render = load('../public/main.js', 'renderReport', 'function renderReportContent(', {
      InformationSettings: { isEnabled: () => true }, informationCategorySettings: {},
      displaySettingsAvailable: true, showTrainingBroadcasts: enabled, ReportTtl, TrainingReportFilter,
      displayStateSnapshot: () => String(rendered), renderReportContent: () => { rendered++; },
    });
    assert.equal(render(captured).status, enabled ? 'applied' : 'skipped');
    assert.equal(render({ ...captured, replay_age_ms: ReportTtl.TTL.OFFICIAL_TRAINING }).reason, 'expired');
    assert.equal(render({ ...captured, a4_hazard_type: 'Missile' }).status, 'applied');
  }
});

test('captured test expires at 20 minutes in storage and reconnect replay, real J-Alert keeps 24 hours', () => {
  const ttl = ReportTtl.TTL.OFFICIAL_TRAINING;
  assert.equal(ReportTtl.ttlMsForReport(captured), ttl);
  const entries = [{ report: captured, receivedAt: 1000 }];
  assert.equal(pruneExpiredReports(entries, 1000 + ttl - 1).length, 1);
  assert.equal(pruneExpiredReports(entries, 1000 + ttl).length, 0);
  assert.equal(ReportTtl.remainingTtlMsForReport({ ...captured, replay_age_ms: ttl - 1 }), 1);
  assert.equal(ReportTtl.remainingTtlMsForReport({ ...captured, replay_age_ms: ttl }), 0);
  assert.equal(ReportTtl.ttlMsForReport({ ...captured, a4_hazard_type: 'Missile' }), ReportTtl.TTL.JALERT);
  assert.equal(ReportTtl.ttlMsForReport({ ...captured, is_test_data: true }), ReportTtl.TTL.TEST_DATA);
  assert.match(storageKey(captured), /training/);
});

test('training label and expiry timer use the same classification and deadline', () => {
  const label = load('../public/main.js', 'applyTrainingLabel', '// 画素の表示時刻', { TrainingReportFilter });
  assert.equal(label({}, captured).isTraining, true);
  let timeout, removed;
  const schedule = load('../public/main.js', 'scheduleActiveEventExpiry', '// 震源と震度', {
    clearTimeout() {}, Date: { now: () => 1000 },
    setTimeout(fn, ms) { timeout = { fn, ms }; return 1; },
    removeActiveEvent(id) { removed = id; },
  });
  schedule({ id: 'captured-test' }, {}, ReportTtl.remainingTtlMsForReport(captured));
  assert.equal(timeout.ms, 20 * 60 * 1000);
  timeout.fn();
  assert.equal(removed, 'captured-test');
});

test('captured test builds a purple training card and area fill instead of an emergency warning', () => {
  const build = load('../public/main.js', 'buildEventFromJAlert', '// Lアラート(地方公共団体', {
    TrainingReportFilter, JALERT_HAZARD_JA: {}, JALERT_SEVERITY_COLOR: { Extreme: '#ff0000' },
    jalertSeverityJa: () => '不明', summarizeList: areas => areas.join(','),
    prefectureFeaturesByName: new Map([['東京都', { properties: { id: 13 }, geometry: {} }]]),
    mainLandBounds: () => [139, 35, 140, 36], unionBounds: bounds => bounds[0],
    jalertMatchKey: () => 'Test alert|東京都', nowTimeString: () => '11:00',
  });
  const event = build(captured);
  assert.equal(event.geo.prefectures[0].color, '#7a4fd1');
  assert.match(event.badgeClass, /sev-training/);
  assert.match(event.headline, /\(訓練\)$/);
});

test('browser script load order supplies the shared filter to TTL', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const context = vm.createContext({});
  for (const match of html.matchAll(/<script src="(training-report-filter.js|report-ttl.js)" defer><\/script>/g)) {
    vm.runInContext(fs.readFileSync(require.resolve(`../public/${match[1]}`), 'utf8'), context);
  }
  assert.equal(context.ReportTtl.ttlMsForReport(captured), 20 * 60 * 1000);
});

test('named and nearby events never merge across live, training and manual test scopes', () => {
  const live = { jalertKey: 'Missile|東京都', updatedAt: 1000 };
  const training = { ...live, isTraining: true };
  const manual = { ...live, isTestData: true };
  const match = load('../public/main.js', 'findMatchingGroup', '// アクティブな全イベント', {
    activeEvents: new Map([['live', live], ['training', training], ['manual', manual]]),
    Date: { now: () => 1000 },
  });
  for (const [scope, expected] of [[{}, live], [{ isTraining: true }, training], [{ isTestData: true }, manual]]) {
    assert.equal(match({}, { ...scope, jalertKey: live.jalertKey }), expected);
    assert.equal(match({}, scope), expected);
  }
});

test('J-Alert cancellation preserves displays from other scopes', () => {
  const {EventStore}=require('../public/display-events');
  const store=new EventStore({setTimer:()=>null,clearTimer:()=>{}});
  const live={...captured,a4_hazard_type:'Missile'};
  store.receive(live);store.receive({...live,is_test_data:true});store.receive({...live,report_classification_no:7});
  store.receive({...live,a1_message_type:'All Clear'});
  assert.equal(store.events.size,2);
  assert.ok([...store.events.values()].every(e=>e.scope!=='live'));
});
