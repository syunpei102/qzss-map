const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/main.js'), 'utf8');
const helpersStart = source.indexOf('function ashDisplayKey(');
const helpersEnd = source.indexOf('// 降灰(9)を地図に', helpersStart);
const branchStart = source.indexOf('  if ([4, 6, 9].includes(report.disaster_category_no))');
const branchEnd = source.indexOf('  // キャンセル報(取消)', branchStart);
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart && branchStart >= 0 && branchEnd > branchStart);

function setup() {
  const otherReports = new Map();
  const visible = [];
  let nextTimer = 0;
  const context = {
    otherReports,
    ASH_FALL_SEVERITY: { 1: 1, 2: 2, 3: 3, 4: 3 },
    TTL_OTHER_CATEGORY_MS: 60_000,
    TTL_TSUNAMI_INFO_MS: 60_000,
    tsunamiInfoHasLocation: () => true,
    applyTrainingLabel: (event) => event,
    buildEventFromOtherCategory: (report) => ({
      report,
      geo: { ellipse: { areas: report.local_governments_raw } },
    }),
    syncActiveEventLayers: () => {
      visible.push([...otherReports.values()].flatMap((record) => record.geo.ellipse ? [record.geo.ellipse] : []));
    },
    renderEventsPanel: () => {},
    setTimeout: () => ++nextTimer,
    clearTimeout: () => {},
  };
  const accept = vm.runInNewContext(
    `${source.slice(helpersStart, helpersEnd)}\nfunction accept(report) {\n${source.slice(branchStart, branchEnd)}\n}\naccept`,
    context,
  );
  return { accept, otherReports, visible };
}

function ash(areas, time = '2026-10-28T03:21:00', extra = {}) {
  return {
    disaster_category_no: 9,
    volcano_name: '桜島',
    activity_time: '2026-10-28T02:58:00',
    report_time: time,
    local_governments_raw: areas,
    local_governments: areas.map(String),
    expected_ash_fall_times: areas.map(() => 3),
    ash_fall_warning_codes_raw: areas.map(() => 2),
    ash_fall_warning_codes: areas.map(() => 'やや多量の降灰'),
    ...extra,
  };
}

test('fragments of one ash forecast produce one map shape and one combined report', () => {
  const { accept, otherReports, visible } = setup();
  accept(ash([46201, 46214]));
  accept(ash([46214, 46482]));
  assert.equal(otherReports.size, 1);
  assert.equal(visible.at(-1).length, 1);
  const record = [...otherReports.values()][0];
  assert.deepEqual([...record.report.local_governments_raw], [46201, 46214, 46482]);
  assert.equal(record.ashFragments.size, 2);
  accept(ash([46201, 46214]));
  assert.equal([...otherReports.values()][0].ashFragments.size, 2, 'retransmission does not add another shape');
});

test('newer ash issue replaces old forecast; stale replay and cancellation are handled', () => {
  const { accept, otherReports } = setup();
  accept(ash([46201]));
  accept(ash([46482], '2026-10-28T04:21:00'));
  accept(ash([46201]));
  assert.deepEqual([...([...otherReports.values()][0].report.local_governments_raw)], [46482]);
  accept(ash([], '2026-10-28T03:21:00', { information_type_no: 2 }));
  assert.equal(otherReports.size, 1, 'old cancellation must not remove the newer forecast');
  accept(ash([], '2026-10-28T04:21:00', { information_type_no: 2 }));
  assert.equal(otherReports.size, 0);
});

test('live and test ash forecasts do not replace one another', () => {
  const { accept, otherReports } = setup();
  accept(ash([46201]));
  accept(ash([46482], '2026-10-28T03:21:00', { is_test_data: true }));
  assert.equal(otherReports.size, 2);
  accept(ash([], '2026-10-28T03:21:00', { information_type_no: 2, is_test_data: true }));
  assert.equal(otherReports.size, 1);
  assert.equal([...otherReports.values()][0].report.is_test_data, undefined);
});

test('official training, local tests and live forecasts stay separate', () => {
  const { accept, otherReports } = setup();
  accept(ash([46201]));
  accept(ash([46214], '2026-10-28T03:21:00', { report_classification_no: 7 }));
  accept(ash([46482], '2026-10-28T03:21:00', { is_test_data: true }));
  assert.equal(otherReports.size, 3);
});
