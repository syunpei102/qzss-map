const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EEW_FILL_TTL_MS, fromReport, merge, expire } = require('../public/earthquake-fill');

const eew = (extras = {}) => ({ disaster_category_no: 1, ...extras });
const intensity = { disaster_category_no: 3 };
const red = [{ id: 1, color: '#ff2800' }, { id: 2, color: '#ff2800' }];
const observed = [{ id: 1, color: '#dbb85c', label: '4' }];

test('observed intensity replaces every EEW region, including areas without an observation', () => {
  const state = merge(fromReport(eew(), red, 0), fromReport(intensity, observed, 1000));
  assert.equal(state.phase, 'observed');
  assert.deepEqual(state.prefectures, observed);
  assert.deepEqual(merge(state, fromReport(eew(), red, 2000)).prefectures, observed,
    'a later EEW or replay must not restore the red areas');
});

test('an intensity report with no prefectures still clears all EEW fill', () => {
  const state = merge(fromReport(eew(), red, 0), fromReport(intensity, [], 1000));
  assert.equal(state.phase, 'observed');
  assert.deepEqual(state.prefectures, []);
  assert.deepEqual(merge(state, fromReport(eew(), red, 2000)).prefectures, []);
});

test('EEW fill expires five minutes after the last report, independently of its card', () => {
  let state = fromReport(eew(), red, 0);
  assert.equal(state.deadline, EEW_FILL_TTL_MS);
  state = merge(state, fromReport(eew(), red, 60_000));
  assert.equal(state.deadline, EEW_FILL_TTL_MS + 60_000);
  assert.equal(expire(state, EEW_FILL_TTL_MS + 59_999).phase, 'eew');
  assert.deepEqual(expire(state, EEW_FILL_TTL_MS + 60_000).prefectures, []);
});

test('reconnect uses original reception age instead of restarting five minutes', () => {
  const recent = fromReport(eew({ replay_age_ms: 4 * 60_000 }), red, 1_000_000);
  assert.equal(recent.deadline, 1_060_000);
  const stale = fromReport(eew({ replay_age_ms: EEW_FILL_TTL_MS }), red, 1_000_000);
  assert.equal(stale.phase, 'expired');
  assert.deepEqual(stale.prefectures, []);
});

test('a new earthquake retires old intensity but keeps tsunami coast and card', () => {
  const source = fs.readFileSync(require.resolve('../public/main.js'), 'utf8');
  const start = source.indexOf('function retirePreviousEarthquakes(incomingEvent) {');
  const end = source.indexOf('\n}\n', start) + 3;
  assert.ok(start >= 0 && end > start);
  const oldIntensity = {
    id: 1, disasterCategoryNo: 3,
    epicenterRaw: 350, occurrenceTime: '2026-10-19T04:40:00',
    geo: { prefectures: observed, tsunami: [], hypocenter: { lon: 1, lat: 1 } },
    markers: { intensityBadges: [] },
  };
  let removedBadge = false;
  const oldTsunami = {
    id: 2, disasterCategoryNo: 1,
    geo: { prefectures: red, tsunami: [{ code: 123, color: '#c800c8' }], hypocenter: { lon: 2, lat: 2 } },
    tsunamiSnapshot: {
      disasterCategoryNo: 5, geo: { prefectures: [], tsunami: [{ code: 123, color: '#c800c8' }], hypocenter: null },
      rows: [['津波の高さ', '3m']], headline: '大津波警報', bounds: [1, 2, 3, 4],
    },
    markers: { intensityBadges: [{ remove() { removedBadge = true; } }] },
    updatedAt: 50,
  };
  const activeEvents = new Map([[1, oldIntensity], [2, oldTsunami]]);
  let synced = 0;
  const context = {
    activeEvents,
    retiredEarthquakes: [],
    TTL_HYPOCENTER_INTENSITY_MS: 20 * 60_000,
    EarthquakeIdentity: require('../public/earthquake-identity'),
    removeActiveEvent(id) { activeEvents.delete(id); },
    syncActiveEventLayers() { synced++; },
    updateWeatherDisplay() {}, renderEventsPanel() {}, clearTimeout() {},
  };
  vm.runInNewContext(source.slice(start, end) + '\nretirePreviousEarthquakes({ isTestData: false, isTraining: false });', context);
  assert.equal(activeEvents.has(1), false);
  assert.equal(activeEvents.get(2).disasterCategoryNo, 5);
  assert.deepEqual(activeEvents.get(2).geo.tsunami, oldTsunami.tsunamiSnapshot.geo.tsunami);
  assert.deepEqual(activeEvents.get(2).geo.prefectures, []);
  assert.equal(activeEvents.get(2).rows[0][0], '津波の高さ');
  assert.equal(removedBadge, true);
  assert.ok(synced);

  const retiredStart = source.indexOf('function isRetiredEarthquake(report) {');
  const retiredEnd = source.indexOf('\n}\n', retiredStart) + 3;
  vm.runInNewContext(source.slice(retiredStart, retiredEnd) + '\nresult = [\n'
    + "isRetiredEarthquake({ seismic_epicenter_raw: 350, occurrence_time_of_earthquake: '2026-10-19T04:40:00' }),\n"
    + "isRetiredEarthquake({ seismic_epicenter_raw: 350, occurrence_time_of_earthquake: '2026-10-19T04:42:00' })\n];", context);
  assert.deepEqual([...context.result], [true, false], 'late reports from the retired earthquake stay hidden');
});
