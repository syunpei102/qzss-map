const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/main.js'), 'utf8');
function loadFunction(name, nextMarker, context) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`${source.slice(start, end)}; ${name}`, context);
}

test('earthquake and tsunami training cards visibly identify the exercise', () => {
  const render = loadFunction('buildReportCardHtml', '// パネルに一度に出すカード数', {
    escapeHtml: (value) => String(value),
    cardSeverityClass: () => 'sev-training',
    TSUNAMI_DEFAULT_COLOR: '#ff2800',
  });
  const card = { isTraining: true, isTestData: false, tsunamiWarningActive: true,
    tsunamiWarningColor: '#ff2800', tsunamiWarningText: '津波警報 発表中',
    badgeText: '津波', badgeClass: 'report-badge sev-training', showBadges: false,
    headline: '津波警報', title: '', meta: '受信 10:05', rows: [] };
  const html = render(card);
  assert.ok(html.includes('訓練・試験放送'));
  assert.ok(html.indexOf('訓練・試験放送') < html.indexOf('津波警報 発表中'));
  assert.ok(!render({ ...card, isTraining: false }).includes('訓練・試験放送'));
  const localTrainingHtml = render({ ...card, isTestData: true });
  assert.ok(localTrainingHtml.includes('訓練・試験放送（ローカルテスト）'));
  assert.ok(!localTrainingHtml.includes('🧪 テストデータ'));
  assert.equal((localTrainingHtml.match(/training-data-banner/g) || []).length, 1);
});

test('a training report never merges into an overlapping live panel', () => {
  const cluster = loadFunction('clusterOverlappingRecords', 'function groupOverlappingRecords(', {
    recordsOverlapGeographically: () => true,
  });
  assert.equal(cluster([{ isTraining: true }, { isTraining: false }]).length, 2);
  assert.equal(cluster([{ isTraining: true }, { isTraining: true }]).length, 1);
});

test('only the most recently updated intensity badge remains for each prefecture', () => {
  const select = loadFunction('latestIntensityBadgeMarkers', 'function resolveMarkerOverlaps(', {
    Map, Set,
  });
  const oldIbaraki = { __prefectureId: 8 };
  const newIbaraki = { __prefectureId: 8 };
  const tochigi = { __prefectureId: 9 };
  const selected = select([
    { updatedAt: 100, markers: { intensityBadges: [oldIbaraki, tochigi] } },
    { updatedAt: 200, markers: { intensityBadges: [newIbaraki] } },
  ]);
  assert.equal(selected.has(oldIbaraki), false);
  assert.equal(selected.has(newIbaraki), true);
  assert.equal(selected.has(tochigi), true);
});

test('earthquake focus selects only the newest event during the ten minute hold', () => {
  const now = Date.now();
  const old = { disasterCategoryNo: 3, bounds: [1, 1, 2, 2], updatedAt: now - 11 * 60 * 1000 };
  const recent = { disasterCategoryNo: 3, bounds: [3, 3, 4, 4], updatedAt: now - 2 * 60 * 1000 };
  const latest = { disasterCategoryNo: 5, bounds: [5, 5, 6, 6], updatedAt: now };
  const select = loadFunction('quakeLockRecords', 'function isQuakeLockActive(', {
    activeEvents: new Map([[1, old], [2, recent], [3, latest]]),
    QUAKE_LOCK_CATEGORY_NOS: new Set([1, 2, 3, 5, 6]),
    QUAKE_FOCUS_HOLD_MS: 10 * 60 * 1000,
    isTsunamiRelatedRecord: () => false,
    Date,
  });
  assert.equal(select().length, 1);
  assert.equal(select()[0], latest);
  latest.updatedAt = now - 11 * 60 * 1000;
  recent.updatedAt = now - 11 * 60 * 1000;
  assert.equal(select().length, 0);
});

test('live earthquake remains ahead of a newer training exercise', () => {
  const now = Date.now();
  const live = { disasterCategoryNo: 3, bounds: [1, 1, 2, 2], updatedAt: now - 60 * 1000 };
  const training = { disasterCategoryNo: 3, bounds: [3, 3, 4, 4], updatedAt: now, isTraining: true };
  const select = loadFunction('quakeLockRecords', 'function isQuakeLockActive(', {
    activeEvents: new Map([[1, live], [2, training]]),
    QUAKE_LOCK_CATEGORY_NOS: new Set([1, 2, 3, 5, 6]),
    QUAKE_FOCUS_HOLD_MS: 10 * 60 * 1000,
    isTsunamiRelatedRecord: () => false,
    Date,
  });
  assert.equal(select()[0], live);
});

test('earthquake zoom contains every current intensity prefecture and tsunami coast', () => {
  const boundsById = new Map([[8, [140, 35, 141, 37]], [23, [136, 34, 138, 36]]]);
  const zoomBounds = loadFunction('earthquakeDisplayBounds', '// 最新の地震・津波1件', {
    prefectureFeaturesById: new Map([...boundsById].map(([id, bounds]) => [id, { geometry: { bounds } }])),
    tsunamiFeaturesByCode: new Map([[310, { geometry: { bounds: [141, 34, 142, 36] } }]]),
    mainLandBounds: (geometry) => geometry.bounds,
    geometryBounds: (geometry) => geometry.bounds,
    unionBounds: (items) => [Math.min(...items.map((v) => v[0])), Math.min(...items.map((v) => v[1])),
      Math.max(...items.map((v) => v[2])), Math.max(...items.map((v) => v[3]))],
  });
  const result = zoomBounds({ bounds: [140, 35, 141, 37], geo: {
    prefectures: [{ id: 8 }, { id: 23 }], tsunami: [{ code: 310 }], hypocenter: null,
  } });
  assert.deepEqual([...result], [136, 34, 142, 37]);
});
