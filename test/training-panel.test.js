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
