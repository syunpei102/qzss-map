const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../public/main.js'), 'utf8');
const start = source.indexOf('function mergeIntoActiveEvent(');
const end = source.indexOf('\nfunction removeActiveEvent(', start);
assert.ok(start >= 0 && end > start);

function merge(previousCategory, previousMagnitude) {
  const context = {
    clearTimeout() {}, scheduleEewFillExpiry() {}, scheduleActiveEventExpiry() {},
    scheduleEarthquakeGeoExpiry() {}, syncActiveEventLayers() {}, updateWeatherDisplay() {},
    syncIntensityBadgeAnchors() {}, requestAnimationFrame() {},
    createIntensityBadgeMarkers: () => [],
    isEarthquakeOrTsunamiRecord: () => true,
    EarthquakeFill: { merge: () => ({ phase: 'intensity', prefectures: [] }) },
    currentPatrolCode: null, currentPatrolTrainingId: null,
  };
  const mergeIntoActiveEvent = vm.runInNewContext(`${source.slice(start, end)}; mergeIntoActiveEvent`, context);
  const record = { disasterCategoryNo: previousCategory,
    rows: previousMagnitude ? [['マグニチュード', previousMagnitude]] : [],
    badges: [{ text: '緊急地震速報', class: 'sev-emergency' }],
    geo: { hypocenter: null, tsunami: [], prefectures: [] },
    markers: { intensityBadges: [] }, earthquakeFill: { phase: 'eew' }, bounds: null };
  const event = { disasterCategoryNo: 3, badgeText: '震度情報', badgeClass: 'sev-warning',
    rows: [['最大震度', '震度4(熊本県)'], ['マグニチュード', '震度電文に記載なし']],
    geo: { hypocenter: null, tsunami: [], prefectures: [] },
    earthquakeFill: { phase: 'intensity' }, bounds: null };
  mergeIntoActiveEvent(record, event, { disaster_category_no: 3,
    occurrence_time_of_earthquake: '2026-11-20T12:46:00' });
  return record.rows.find(([key]) => key === 'マグニチュード')[1];
}

test('同一地震の緊急地震速報から震度へMと出典を引き継ぐ', () => {
  assert.equal(merge(1, 'M5.2'), 'M5.2（緊急地震速報の推定値）');
});

test('同一地震の震源情報から震度へMを引き継ぐ', () => {
  assert.equal(merge(2, 'M5.1'), 'M5.1（震源情報）');
});

test('震度だけの場合と続報ではMを捏造・書き換えしない', () => {
  assert.equal(merge(3, null), '震度電文に記載なし');
  assert.equal(merge(3, 'M5.2（緊急地震速報の推定値）'), 'M5.2（緊急地震速報の推定値）');
});
