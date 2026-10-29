const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/main.js'), 'utf8');
function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

const helpers = section('function tsunamiSnapshotForEvent(', '// 別の地震のEEWが来たとき');
const merger = section('function mergeIntoActiveEvent(', 'function removeActiveEvent(');
const context = {
  Map, Set, Date, clearTimeout: () => {}, setTimeout: () => null,
  requestAnimationFrame: () => {},
  summarizeList: (values) => values.join('・'),
  unionBounds: (bounds) => [Math.min(...bounds.map((b) => b[0])), Math.min(...bounds.map((b) => b[1])),
    Math.max(...bounds.map((b) => b[2])), Math.max(...bounds.map((b) => b[3]))],
  syncActiveEventLayers: () => {}, updateWeatherDisplay: () => {},
  resolveMarkerOverlaps: () => {}, updateFocusOutline: () => {},
  isEarthquakeOrTsunamiRecord: () => true,
  currentPatrolCode: null, currentPatrolTrainingId: null,
};
const merge = vm.runInNewContext(`${helpers}\n${merger}; mergeIntoActiveEvent`, context);

function incoming(code, name, height, warningCode = 3, warningText = '津波警報') {
  return {
    disasterCategoryNo: 5, tsunamiCoasts: [{ code, name, height, warningCode, warningText,
      color: warningCode === 4 ? '#c800c8' : '#ff2800' }],
    geo: { tsunami: [{ code, color: '#ff2800' }], prefectures: [], hypocenter: null },
    rows: [['対象沿岸', name], ['津波の高さ', height]],
    bounds: [code, 0, code + 1, 1], headline: warningText,
    tsunamiWarningText: warningText, tsunamiWarningActive: true,
    tsunamiWarningColor: '#ff2800', badgeText: '津波', badgeClass: 'sev-warning',
    quakeFocusAt: Date.now(), markers: { intensityBadges: [] },
  };
}

function recordFrom(event) {
  return { ...event, id: 1, tsunamiCoasts: [...event.tsunamiCoasts],
    geo: { ...event.geo, tsunami: [...event.geo.tsunami] }, rows: [...event.rows],
    badges: [{ text: '津波', class: 'sev-warning' }],
    tsunamiSnapshot: { ...event }, timer: null,
    markers: { intensityBadges: [] }, updatedAt: Date.now() };
}

test('replayed coast reports retain every coast and update only the repeated coast', () => {
  const record = recordFrom(incoming(600, '愛媛県宇和海沿岸', '3m'));
  merge(record, incoming(610, '高知県', '3m'), { disaster_category_no: 5 });
  merge(record, incoming(760, '宮崎県', '3m'), { disaster_category_no: 5 });
  assert.deepEqual(Array.from(record.geo.tsunami, (coast) => coast.code), [600, 610, 760]);
  assert.equal(new Map(record.rows).get('対象沿岸'), '愛媛県宇和海沿岸・高知県・宮崎県');
  assert.equal(new Map(record.rows).get('津波の高さ'), '3m');
  assert.deepEqual(Array.from(record.tsunamiSnapshot.geo.tsunami, (coast) => coast.code), [600, 610, 760]);
  merge(record, incoming(610, '高知県', '5m', 4, '大津波警報'), { disaster_category_no: 5 });
  assert.equal(record.tsunamiCoasts.length, 3);
  assert.equal(new Map(record.rows).get('津波の高さ'), '3m・5m');
  assert.equal(record.tsunamiWarningText, '大津波警報');
  assert.equal(record.tsunamiWarningColor, '#c800c8');
  assert.equal(record.geo.tsunami.find((coast) => coast.code === 610).color, '#c800c8');
});
