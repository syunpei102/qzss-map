const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/main.js'), 'utf8');
const start = source.indexOf('function handleVolcanoReport(');
const end = source.indexOf('// 降灰(9)の対象地域', start);
assert.ok(start >= 0 && end > start);

test('loading volcano coordinates replaces its fallback card instead of drawing twice', () => {
  const activeEvents = new Map();
  const otherReports = new Map();
  const volcanoesByName = new Map();
  const clearedTimers = [];
  let nextTimer = 0;
  let nextEvent = 0;
  const context = {
    activeEvents,
    otherReports,
    volcanoesByName,
    VOLCANO_DANGEROUS_CODES: new Set([52]),
    VOLCANO_SEVERITY_COLOR: { 'sev-tokubetsu': '#8e24aa' },
    TTL_VOLCANO_MS: 12 * 60 * 60 * 1000,
    cleanDescriptionMessage: (message) => message,
    volcanoSeverityClass: () => 'sev-tokubetsu',
    volcanoWarningRadiusKm: () => 2,
    nowTimeString: () => '12:00',
    ellipsePolygon: (center) => ({ center }),
    geometryBounds: () => [130, 31, 131, 32],
    applyTrainingLabel: (event) => event,
    isRelevantToTargetRegion: () => true,
    findMatchingGroup: (_, event) => [...activeEvents.values()].find((record) => record.volcanoKey === event.volcanoKey),
    mergeIntoActiveEvent: (record, event) => Object.assign(record, event),
    addActiveEvent: (event) => activeEvents.set(++nextEvent, event),
    removeActiveEvent: (id) => activeEvents.delete(id),
    syncActiveEventLayers: () => {},
    setTimeout: () => ++nextTimer,
    clearTimeout: (timer) => clearedTimers.push(timer),
  };
  const handleVolcanoReport = vm.runInNewContext(`${source.slice(start, end)}; handleVolcanoReport`, context);
  const report = { disaster_category_no: 8, volcano_name: '桜島', volcanic_warning_code_raw: 52,
    volcanic_warning_code: '噴火', description: '噴火しました' };

  handleVolcanoReport(report);
  assert.equal(otherReports.size, 1);
  assert.equal(activeEvents.size, 0);
  const fallbackTimer = otherReports.get('volcano:桜島').timer;

  volcanoesByName.set('桜島', { lon: 130.66, lat: 31.58 });
  handleVolcanoReport(report);
  assert.equal(otherReports.size, 0);
  assert.equal(activeEvents.size, 1);
  assert.equal(clearedTimers.includes(fallbackTimer), true);
  assert.ok([...activeEvents.values()][0].geo.ellipse);

  handleVolcanoReport(report);
  assert.equal(activeEvents.size, 1, 'a repeated report updates the same circle');
  handleVolcanoReport({ ...report, information_type_no: 2 });
  assert.equal(activeEvents.size, 0);
  assert.equal(otherReports.size, 0);
});
