const { test } = require('node:test');
const assert = require('node:assert/strict');
const { updateActiveReports } = require('../report-state');
const put = (entries, report, end = false) => updateActiveReports(entries, report, 100, end);

test('two volcanoes survive replay and a targeted cancellation', () => {
  const a = { disaster_category_no: 8, volcano_name: 'A' };
  const b = { ...a, volcano_name: 'B' };
  let state = put(put([], a), b);
  assert.equal(state.length, 2);
  state = put(state, a, true);
  assert.deepEqual(state.map(e => e.report.volcano_name), ['B']);
});
test('earthquake replay retains EEW, hypocenter and intensity; cancellation clears group', () => {
  let state = [];
  for (const cat of [1, 2, 3]) state = put(state, { disaster_category_no: cat, seismic_epicenter_raw: 123 });
  assert.deepEqual(state.map(e => e.report.disaster_category_no), [1, 2, 3]);
  state = put(state, { disaster_category_no: 2, seismic_epicenter_raw: 123, magnitude: 6 });
  assert.equal(state.length, 3);
  assert.equal(put(state, { disaster_category_no: 1, seismic_epicenter_raw: 123 }, true).length, 0);
});
test('tsunami partial updates retain other coasts and aligned heights, global resolution clears', () => {
  const first = { disaster_category_no: 5, tsunami_forecast_regions_raw: [100, 200], tsunami_heights_raw: [3, 4] };
  const next = { disaster_category_no: 5, tsunami_forecast_regions_raw: [100], tsunami_heights_raw: [5] };
  let state = put(put([], first), next);
  assert.deepEqual(state.map(e => [e.report.tsunami_forecast_regions_raw[0], e.report.tsunami_heights_raw[0]]), [[200, 4], [100, 5]]);
  assert.equal(put(state, { disaster_category_no: 5 }, true).length, 0);
});
test('river cancellation preserves other rivers, including legacy combined entries', () => {
  const report = { disaster_category_no: 11, flood_forecast_regions_raw: [10000, 20000], flood_warning_levels_raw: [3, 4] };
  const old = [{ report, receivedAt: 50 }];
  const state = put(old, { disaster_category_no: 11, flood_forecast_regions_raw: [10000] }, true);
  assert.deepEqual(state.map(e => e.report.flood_forecast_regions_raw), [[20000]]);
  assert.equal(state[0].receivedAt, 50);
  assert.equal(put(state, { disaster_category_no: 11 }, true).length, 0);
});
test('ash from different volcanoes and areas is retained', () => {
  let state = [];
  for (const [name, area] of [['A', 1], ['A', 2], ['B', 3]]) {
    state = put(state, { disaster_category_no: 9, volcano_name: name, local_governments_raw: [area] });
  }
  assert.equal(state.length, 3);
  assert.deepEqual(put(state, { disaster_category_no: 9, volcano_name: 'A' }, true).map(e => e.report.volcano_name), ['B']);
});
test('test data does not overwrite or cancel a live report', () => {
  const live = { disaster_category_no: 8, volcano_name: 'A' };
  const state = put(put([], live), { ...live, is_test_data: true });
  assert.equal(state.length, 2);
  assert.equal(put(state, { ...live, is_test_data: true }, true).length, 1);
});
test('weather warning replay replaces same region set and cancellation clears it', () => {
  const report = { disaster_category_no: 10, weather_forecast_regions_raw: [130010, 140010] };
  let state = put([], report);
  assert.equal(state.length, 2, 'stored per region');
  state = put(state, { ...report, a1_message_type: 'Update' });
  assert.equal(state.length, 2);
  assert.equal(put(state, report, true).length, 0);
});
test('weather warning update to a subset of regions drops no stale snapshot', () => {
  const base = { disaster_category_no: 10, weather_forecast_regions_raw: [100, 200],
    weather_forecast_regions: ['A', 'B'], weather_related_disaster_sub_categories: ['x', 'y'] };
  let state = put([], base);
  state = put(state, { ...base, weather_forecast_regions_raw: [100], weather_forecast_regions: ['A'],
    weather_related_disaster_sub_categories: ['z'] });
  const view = state.map(({ report }) => [report.weather_forecast_regions_raw, report.weather_forecast_regions, report.weather_related_disaster_sub_categories]);
  assert.deepEqual(view, [[[200], ['B'], ['y']], [[100], ['A'], ['z']]]);
});
test('weather warning cancellation removes only the addressed region from a combined legacy entry', () => {
  const combined = {
    disaster_category_no: 10,
    weather_forecast_regions_raw: [130010, 140010],
    weather_forecast_regions: ['Tokyo', 'Kanagawa'],
    weather_related_disaster_sub_categories: ['Heavy rain', 'Flood'],
  };
  const state = put(
    [{ report: combined, receivedAt: 50 }],
    {
      disaster_category_no: 10,
      information_type_no: 2,
      weather_forecast_regions_raw: [130010],
      weather_forecast_regions: ['Tokyo'],
      weather_related_disaster_sub_categories: ['Heavy rain'],
    },
    true
  );
  assert.deepEqual(
    state.map(({ report }) => ({
      codes: report.weather_forecast_regions_raw,
      names: report.weather_forecast_regions,
      subCategories: report.weather_related_disaster_sub_categories,
    })),
    [{ codes: [140010], names: ['Kanagawa'], subCategories: ['Flood'] }]
  );
});
test('J-Alert groups by hazard and area, independent of other J-Alert areas', () => {
  const tokyo = { type: 'QzssDcxJAlert', a4_hazard_type: 'Missile', ex9_target_area_list_ja: ['Tokyo'] };
  const osaka = { type: 'QzssDcxJAlert', a4_hazard_type: 'Missile', ex9_target_area_list_ja: ['Osaka'] };
  let state = put(put([], tokyo), osaka);
  assert.equal(state.length, 2);
  state = put(state, tokyo, true);
  assert.deepEqual(state.map(e => e.report.ex9_target_area_list_ja), [['Osaka']]);
});
test('unrecognized disaster category still replaces on replay and clears on cancel', () => {
  const report = { disaster_category_no: 99 };
  let state = put([], report);
  assert.equal(state.length, 1);
  state = put(state, { ...report, note: 'updated' });
  assert.equal(state.length, 1);
  assert.equal(put(state, report, true).length, 0);
});
test('reports with no derivable group key are kept independently and never auto-cancel', () => {
  const unknown = { type: 'SomethingElse' };
  let state = put(put([], unknown), unknown);
  assert.equal(state.length, 2, 'group-less reports are never deduplicated against each other');
  assert.equal(put(state, unknown, true).length, 2, 'group-less cancellation is a no-op (fail-safe: never delete blindly)');
});
test('earthquake without epicenter or occurrence time falls back to an unknown bucket per kind', () => {
  const a = { disaster_category_no: 1 };
  const b = { disaster_category_no: 2 };
  let state = put(put([], a), b);
  assert.equal(state.length, 2, 'both group under eq|unknown but storageKey keeps EEW/hypocenter distinct by kind');
  state = put(state, { disaster_category_no: 1, note: 'updated' });
  assert.equal(state.length, 2, 'a same-kind replay still replaces only its own kind');
  assert.equal(put(state, a, true).length, 0, 'cancellation matches on the coarser eq|unknown group and clears both');
});
test('earthquakes at the same epicenter but different occurrence times remain independent', () => {
  const first = {
    disaster_category_no: 1,
    seismic_epicenter_raw: 123,
    occurrence_time_of_earthquake: '2026-09-21T00:00:00',
  };
  const second = {
    ...first,
    occurrence_time_of_earthquake: '2026-09-21T00:05:00',
  };
  let state = put(put([], first), second);
  assert.deepEqual(
    state.map(({ report }) => report.occurrence_time_of_earthquake),
    [first.occurrence_time_of_earthquake, second.occurrence_time_of_earthquake]
  );
  state = put(state, first, true);
  assert.deepEqual(
    state.map(({ report }) => report.occurrence_time_of_earthquake),
    [second.occurrence_time_of_earthquake]
  );
});
test('L-Alert with an incomplete ellipse coordinate does not crash grouping', () => {
  const incomplete = {
    type: 'QzssDcxLAlert',
    a4_hazard_type: 'Flood',
    a12_ellipse_centre_latitude: 35.5,
  };
  assert.doesNotThrow(() => put([], incomplete));
});

test('L-Alert ellipse key needs both finite coordinates', () => {
  const { reportGroupKey } = require('../report-state');
  const base = { type: 'QzssDcxLAlert', a4_hazard_type: 'Flood' };
  for (const bad of [{ a12_ellipse_centre_latitude: 35 }, { a13_ellipse_centre_longitude: 139 },
    { a12_ellipse_centre_latitude: NaN, a13_ellipse_centre_longitude: 1 },
    { a12_ellipse_centre_latitude: 1, a13_ellipse_centre_longitude: Infinity }]) {
    assert.equal(reportGroupKey({ ...base, ...bad }), 'lalert|Flood|unknown');
  }
  assert.equal(reportGroupKey({ ...base, a12_ellipse_centre_latitude: 35.123, a13_ellipse_centre_longitude: 139.456 }),
    'lalert|Flood|ellipse:35.12,139.46');
});
test('earthquake compares every field present on both sides; missing fields fall back', () => {
  const { sameEarthquake } = require('../report-state');
  const t = 'T1';
  assert.equal(sameEarthquake({ occurrence_time_of_earthquake: t, seismic_epicenter_raw: 1 }, { occurrence_time_of_earthquake: t, seismic_epicenter_raw: 2 }), false, 'same time, different epicenter');
  assert.equal(sameEarthquake({ occurrence_time_of_earthquake: t, seismic_epicenter_raw: 1 }, { occurrence_time_of_earthquake: 'T2', seismic_epicenter_raw: 1 }), false);
  assert.equal(sameEarthquake({ occurrence_time_of_earthquake: t, seismic_epicenter_raw: 1 }, { seismic_epicenter_raw: 1 }), true);
  assert.equal(sameEarthquake({ occurrence_time_of_earthquake: t }, { seismic_epicenter_raw: 1 }), false);
});
test('server and browser share one TTL table; prune boundaries', () => {
  const { pruneExpiredReports } = require('../report-state');
  const { ttlMsForReport, TTL } = require('../public/report-ttl');
  const H = 3600 * 1000;
  const cases = [
    [{ disaster_category_no: 1 }, 20 * 60 * 1000],
    [{ disaster_category_no: 8 }, 12 * H],
    [{ disaster_category_no: 5 }, 24 * H],
    [{ type: 'QzssDcxLAlert', a8_hazard_duration: 'Duration < 6H' }, 6 * H],
    [{ type: 'QzssDcxLAlert', a8_hazard_duration: '6H <= Duration < 12H' }, 12 * H],
    [{ type: 'QzssDcxLAlert', a8_hazard_duration: '12H <= Duration < 24H' }, 24 * H],
    [{ type: 'QzssDcxLAlert', a8_hazard_duration: 'Unknown' }, TTL.LALERT_UNKNOWN],
    [{ type: 'QzssDcxLAlert' }, 3 * H],
    [{ disaster_category_no: 1, is_test_data: true }, 60 * 1000],
  ];
  for (const [report, ttl] of cases) {
    assert.equal(ttlMsForReport(report), ttl, JSON.stringify(report));
    const entries = [{ report, receivedAt: 1000 }];
    assert.equal(pruneExpiredReports(entries, 1000 + ttl - 1).length, 1, 'just before TTL');
    assert.equal(pruneExpiredReports(entries, 1000 + ttl).length, 0, 'at TTL');
  }
});
