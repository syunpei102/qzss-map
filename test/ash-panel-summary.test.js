const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/main.js'), 'utf8');
const start = source.indexOf('function ashSummaryRows(');
const end = source.indexOf('// 洪水(11)は専用', start);
assert.ok(start >= 0 && end > start);
const summarize = vm.runInNewContext(`${source.slice(start, end)}\nashSummaryRows`, {
  ASH_FALL_SEVERITY: { 1: 1, 2: 2, 3: 3, 4: 3, 7: 1 },
});

test('many ash forecast regions fit in three short rows', () => {
  const areas = Array.from({ length: 35 }, (_, i) => 46201 + i);
  const rows = summarize({
    local_governments_raw: areas,
    local_governments: areas.map((_, i) => i === 0 ? '鹿児島市' : `地域${i}`),
    ash_fall_warning_codes_raw: areas.map((_, i) => i % 2 ? 2 : 3),
    ash_fall_warning_codes: areas.map(() => '多量の降灰'),
    expected_ash_fall_times: areas.map((_, i) => i % 2 ? 1 : 3),
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0][1], '多量・やや多量');
  assert.equal(rows[1][1], '鹿児島市ほか34地域');
  assert.equal(rows[2][1], '基点から1～3時間後');
  assert.ok(JSON.stringify(rows).length < 100);
});

test('the rendered ash card uses the compact rows and volcano headline', () => {
  const eventStart = source.indexOf('function buildEventFromOtherCategory(');
  const eventEnd = source.indexOf('// azarashiのflood_forecast_regions_raw', eventStart);
  assert.ok(eventStart > 0 && eventEnd > eventStart);
  const build = vm.runInNewContext(`${source.slice(eventStart, eventEnd)}\nbuildEventFromOtherCategory`, {
    ashSummaryRows: summarize,
    computeAshFallEllipse: () => ({ ellipse: {}, bounds: null, pending: false }),
    otherBadgeClassForReport: () => 'sev-caution',
    nowTimeString: () => '10:00',
    Date,
  });
  const event = build({
    disaster_category_no: 9, disaster_category: '降灰予報', volcano_name: '桜島',
    local_governments_raw: [46201, 46214], local_governments: ['鹿児島市', '垂水市'],
    ash_fall_warning_codes_raw: [3, 2], expected_ash_fall_times: [1, 3],
    description: '長い説明文'.repeat(50),
  });
  assert.equal(event.headline, '桜島 降灰予報');
  assert.equal(event.rows.length, 3);
  assert.equal(event.message, '');
});

test('missing timing is omitted and the strongest warning remains visible', () => {
  const rows = summarize({
    local_governments: ['鹿児島市'],
    ash_fall_warning_codes_raw: [1, 4],
    expected_ash_fall_times: [null],
  });
  assert.equal(rows.length, 2);
  assert.match(rows[0][1], /^小さな噴石/);
  assert.equal(rows[1][1], '鹿児島市');
});
