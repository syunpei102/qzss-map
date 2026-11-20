const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const EewDisplay = require('../public/eew-display');

// 実電文は保存せず，同じ仮定震源・震度コードを持つ匿名ケースで再現する．
const assumptive = {
  disaster_category_no: 1,
  seismic_epicenter: 'テスト地域',
  magnitude: '1.0', magnitude_raw: 10,
  depth_of_hypocenter: '10km', depth_of_hypocenter_raw: 10,
  assumptive: true,
  seismic_intensity_lower_limit: '震度5弱', seismic_intensity_lower_limit_raw: 6,
  seismic_intensity_upper_limit: '〜程度以上', seismic_intensity_upper_limit_raw: 11,
};
const source = fs.readFileSync(require.resolve('../public/main.js'), 'utf8');
const start = source.indexOf('function tsunamiGuidance(');
const end = source.indexOf('// ==================================================', start);
const buildSummary = vm.runInNewContext(`${source.slice(start, end)}; buildSummary`, {
  EewDisplay, formatDateTime: value => value, summarizeList: values => values.join('・'),
});

test('assumptive EEW does not present fixed magnitude and depth as estimates', () => {
  const rows = buildSummary(assumptive);
  assert.ok(!rows.some(([label]) => ['マグニチュード', '深さ', '震央'].includes(label)));
  assert.equal(rows.find(([label]) => label === '仮定震央')[1], 'テスト地域');
  assert.match(rows.find(([label]) => label === '震源情報')[1], /仮定震源要素/);
  assert.equal(rows.find(([label]) => label === '震度')[1], '震度5弱程度以上');
});

test('assumptive fallback requires EEW and both fixed raw values', () => {
  assert.equal(EewDisplay.isAssumptive({ ...assumptive, assumptive: undefined }), true);
  assert.equal(EewDisplay.isAssumptive({ ...assumptive, assumptive: undefined, magnitude_raw: 11 }), false);
  const realSmallEarthquake = { ...assumptive, disaster_category_no: 2 };
  assert.equal(EewDisplay.isAssumptive(realSmallEarthquake), false);
  assert.equal(buildSummary(realSmallEarthquake).find(([label]) => label === 'マグニチュード')[1], 'M1.0');
});

test('ordinary magnitude/depth and finite intensity ranges remain visible', () => {
  const rows = buildSummary({ ...assumptive, assumptive: false, magnitude: '5.2', magnitude_raw: 52,
    seismic_intensity_upper_limit: '震度6弱', seismic_intensity_upper_limit_raw: 8 });
  assert.equal(rows.find(([label]) => label === 'マグニチュード')[1], 'M5.2');
  assert.equal(rows.find(([label]) => label === '深さ')[1], '10km');
  assert.equal(rows.find(([label]) => label === '震度')[1], '震度5弱〜6弱');
  assert.equal(EewDisplay.predictedIntensity({ seismic_intensity_lower_limit: '震度5弱',
    seismic_intensity_upper_limit: '震度5弱' }), '5弱');
});

test('震度電文にMが無い場合は推測値を表示しない', () => {
  const rows = buildSummary({ disaster_category_no: 3,
    seismic_intensities: ['4'], prefectures: ['熊本県'], occurrence_time_of_earthquake: '2026-11-20T12:46:00' });
  assert.equal(rows.find(([label]) => label === 'マグニチュード')[1], '震度電文に記載なし');
  assert.equal(rows.find(([label]) => label === '最大震度')[1], '震度4(熊本県)');
});

test('open upper bound uses the lower intensity once and accepts older text payloads', () => {
  for (const text of ['〜程度以上', '～程度以上', '~程度以上']) {
    assert.equal(EewDisplay.predictedIntensity({ seismic_intensity_lower_limit: '震度5弱',
      seismic_intensity_upper_limit: text }), '5弱程度以上');
  }
  assert.equal(EewDisplay.predictedIntensity({ seismic_intensity_lower_limit_raw: 8,
    seismic_intensity_upper_limit_raw: 11 }), '6弱程度以上');
});

test('unknown, absent and reserved bounds never become predicted maximum intensities', () => {
  for (const upper of ['不明', 'なし', 'N/A', '震度(上限)(コード番号：12)', '〜程度以上']) {
    assert.equal(EewDisplay.predictedIntensity({ seismic_intensity_upper_limit: upper }), '');
  }
  for (const raw of [12, 14, 15]) {
    assert.equal(EewDisplay.predictedIntensity({ seismic_intensity_lower_limit_raw: 6,
      seismic_intensity_upper_limit_raw: raw, seismic_intensity_upper_limit: '震度7' }), '');
  }
  assert.equal(EewDisplay.predictedIntensity({ seismic_intensity_lower_limit: '震度5弱' }), '');
  assert.equal(EewDisplay.predictedIntensity({ seismic_intensity_lower_limit: '不明',
    seismic_intensity_upper_limit: '震度6強' }), '6強');
});

test('formatter is loaded before main and included in the offline shell', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  assert.ok(html.indexOf('src="eew-display.js"') < html.indexOf('src="main.js"'));
  const sw = fs.readFileSync(require.resolve('../public/sw.js'), 'utf8');
  assert.ok(sw.includes("'./eew-display.js'"));
  const context = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/eew-display'), 'utf8'), context);
  assert.equal(context.EewDisplay.predictedIntensity(assumptive), '5弱程度以上');
});
