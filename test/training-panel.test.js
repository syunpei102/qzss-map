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
  const render = loadFunction('buildReportCardHtml', 'const PANEL_MAX_CARDS', {
    escapeHtml: (value) => String(value),
    cardSeverityClass: () => 'sev-training',
    TSUNAMI_DEFAULT_COLOR: '#ff2800',
    SATELLITE_NAMES: { 56: 'みちびき2号機' },
  });
  const card = { isTraining: true, isTestData: false, tsunamiWarningActive: true,
    tsunamiWarningColor: '#ff2800', tsunamiWarningText: '津波警報 発表中',
    badgeText: '津波', badgeClass: 'report-badge sev-training', showBadges: false,
    headline: '津波警報', title: '', meta: '受信 10:05', rows: [] };
  const html = render(card);
  assert.ok(html.includes('訓練・試験放送'));
  assert.match(html, /report-heading-row[\s\S]*津波警報 発表中[\s\S]*訓練・試験放送[\s\S]*<\/div>/);
  assert.ok(html.indexOf('津波警報 発表中') < html.indexOf('訓練・試験放送'));
  assert.ok(!render({ ...card, isTraining: false }).includes('訓練・試験放送'));
  const localTrainingHtml = render({ ...card, isTestData: true });
  assert.ok(localTrainingHtml.includes('訓練・試験放送（ローカルテスト）'));
  assert.ok(!localTrainingHtml.includes('🧪 テストデータ'));
  assert.equal((localTrainingHtml.match(/training-data-banner/g) || []).length, 1);
  const eewHtml = render({ ...card, tsunamiWarningActive: false, headline: '緊急地震速報' });
  assert.ok(eewHtml.indexOf('緊急地震速報') < eewHtml.indexOf('訓練・試験放送'));
  assert.equal((eewHtml.match(/training-data-banner/g) || []).length, 1);
});

test('J-Alert Test alert uses only one test label', () => {
  const render = loadFunction('buildReportCardHtml', 'const PANEL_MAX_CARDS', {
    escapeHtml: (value) => String(value),
    cardSeverityClass: () => 'sev-training',
    TSUNAMI_DEFAULT_COLOR: '#ff2800',
    SATELLITE_NAMES: { 56: 'みちびき2号機' },
  });
  const html = render({ isTraining: true, isTestData: false, jalertKey: 'Test|Tokyo',
    satellitePrn: 184, satelliteId: 56, headline: 'Test alert(訓練)',
    badges: [{ text: 'Jアラート', class: 'report-badge sev-training' }],
    message: 'これは，Jアラートのテストです．', rows: [['対象', '東京都']], meta: '' });
  assert.ok(html.includes('Test alert(訓練)'));
  assert.ok(!html.includes('訓練・試験放送'));
  assert.ok(!html.includes('>Jアラート</div>'));
});

test('other category training keeps its training indicator on the card', () => {
  const card = loadFunction('otherReportCard', 'function buildReportCardHtml', {})({
    id: 'ash:test:桜島', isTraining: true, isTestData: false,
    badgeText: '降灰', badgeClass: 'sev-training', headline: '降灰',
    rows: [],
  });
  const render = loadFunction('buildReportCardHtml', 'const PANEL_MAX_CARDS', {
    escapeHtml: (value) => String(value),
    cardSeverityClass: () => 'sev-training',
    TSUNAMI_DEFAULT_COLOR: '#ff2800',
    SATELLITE_NAMES: {},
  });
  const html = render(card);
  assert.ok(html.indexOf('降灰') < html.indexOf('訓練・試験放送'));
  assert.equal((html.match(/training-data-banner/g) || []).length, 1);
});

test('mobile abbreviation requires every prefecture in a region', () => {
  const names = new Map([['茨城県', 8], ['栃木県', 9], ['群馬県', 10], ['埼玉県', 11],
    ['千葉県', 12], ['東京都', 13], ['神奈川県', 14]].map(([name, id]) => [name, { properties: { id } }]));
  const region = { id: 'kanto', name: '関東', prefectureIds: [8, 9, 10, 11, 12, 13, 14] };
  const groups = new Map(region.prefectureIds.map((id) => [id, region]));
  const compact = loadFunction('compactCompleteRegions', 'function severityClass(', {
    prefectureFeaturesByName: names, prefectureIdToRegion: groups,
  });
  assert.equal(compact([...names.keys()].join('、')), '関東');
  assert.equal(compact('東京都、千葉県'), '東京都、千葉県');
  assert.equal(compact('東京都千代田区、千葉県'), '東京都千代田区、千葉県');
});

test('same disaster type uses one nationwide card while keeping each region intact', () => {
  const group = loadFunction('groupSameTypePanelCards', 'function panelRecordForDisplay(', {});
  const tokyo = { headline: '大雨警報', title: '東京都', rows: [['対象', '東京都']], updatedAt: 20 };
  const osaka = { headline: '大雨警報', title: '大阪府', rows: [['対象', '大阪府']], updatedAt: 10 };
  const quake = { headline: '緊急地震速報', title: '千島列島', updatedAt: 15 };
  const training = { ...tokyo, isTraining: true, title: '訓練' };
  const result = group([tokyo, osaka, quake, training]);
  assert.equal(result.length, 3);
  const rain = result.find((card) => card.panelGroupRecords);
  assert.equal(rain.panelGroupRecords.length, 2);
  assert.equal(Array.from(rain.panelGroupRecords, (card) => card.title).join(','), '東京都,大阪府');
  assert.equal(result.filter((card) => card.isTraining).length, 1);
});

test('a training report never merges into an overlapping live panel', () => {
  const cluster = loadFunction('clusterOverlappingRecords', 'function groupOverlappingRecords(', {
    recordsOverlapGeographically: () => true,
  });
  assert.equal(cluster([{ isTraining: true }, { isTraining: false }]).length, 2);
  assert.equal(cluster([{ isTraining: true }, { isTraining: true }]).length, 1);
});

test('only the most recently updated intensity badge remains for each prefecture', () => {
  const select = loadFunction('latestIntensityBadgeMarkers', 'function syncIntensityBadgeAnchors(', {
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

test('offshore hypocenter view contains the nearest coast without intensity data', () => {
  const square = { type: 'Polygon', coordinates: [[
    [130, 30], [131, 30], [131, 31], [130, 31], [130, 30],
  ]] };
  const prefectureFeaturesById = new Map([[1, { geometry: square }]]);
  const nearestCoastPoint = loadFunction('nearestCoastPoint', 'function earthquakeDisplayBounds(', {
    prefectureFeaturesById,
    pointInPolygonGeometry: ([lon, lat]) => lon >= 130 && lon <= 131 && lat >= 30 && lat <= 31,
    geometryBounds: () => [130, 30, 131, 31],
    Math,
  });
  let mobile = false;
  const earthquakeDisplayBounds = loadFunction('earthquakeDisplayBounds', '// 最新の地震・津波1件', {
    prefectureFeaturesById,
    tsunamiFeaturesByCode: new Map(),
    nearestCoastPoint,
    isMobileLayout: () => mobile,
    unionBounds: (items) => [Math.min(...items.map((v) => v[0])), Math.min(...items.map((v) => v[1])),
      Math.max(...items.map((v) => v[2])), Math.max(...items.map((v) => v[3]))],
  });
  const record = (lon, lat, bounds = [lon, lat, lon, lat]) => ({ bounds, geo: {
    prefectures: [], tsunami: [], hypocenter: { lon, lat },
  } });
  assert.deepEqual([...earthquakeDisplayBounds(record(132, 30.5))], [131, 30.5, 132, 30.5]);
  mobile = true;
  assert.deepEqual([...earthquakeDisplayBounds(record(132, 30.5))], [130, 30, 132, 31]);
  assert.deepEqual([...earthquakeDisplayBounds(record(130.5, 30.5))], [130.5, 30.5, 130.5, 30.5]);
  assert.deepEqual([...earthquakeDisplayBounds(record(160, 30.5, [129, 30, 160, 45]))], [129, 30, 160, 45]);
});

test('off Sanriku hypocenter uses an actual Japanese coastline point', () => {
  const geojson = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data/prefectures.geojson'), 'utf8'));
  const prefectureFeaturesById = new Map(geojson.features.map((feature) => [feature.properties.id, feature]));
  const pointInPolygonGeometry = vm.runInNewContext(`${source.slice(
    source.indexOf('function pointInRing('), source.indexOf('// Lアラートの楕円(', source.indexOf('function pointInRing(')),
  )}; pointInPolygonGeometry`);
  const geometryBounds = vm.runInNewContext(`${source.slice(
    source.indexOf('function eachCoordinate('), source.indexOf('// 都道府県ジオメトリ'),
  )}; geometryBounds`);
  const nearestCoastPoint = loadFunction('nearestCoastPoint', 'function earthquakeDisplayBounds(', {
    prefectureFeaturesById, pointInPolygonGeometry, geometryBounds, Math,
  });
  const coast = nearestCoastPoint(143, 39);
  assert.ok(coast, '三陸沖の震源から近い海岸が見つかる');
  assert.ok(coast.point[0] < 143 && coast.point[0] > 140);
  assert.ok(coast.point[1] > 37 && coast.point[1] < 41);
  assert.ok(coast.landBounds[0] < coast.point[0] && coast.landBounds[2] >= coast.point[0]);
});

test('tsunami banner and stripe use one shared color for live, training and test cards', () => {
  const render = loadFunction('buildReportCardHtml', 'const PANEL_MAX_CARDS', {
    escapeHtml: (value) => String(value), cardSeverityClass: () => 'sev-training',
    TSUNAMI_DEFAULT_COLOR: '#00a0e9', SATELLITE_NAMES: {},
  });
  for (const color of ['#ff2800', '#c800c8', '#ff9900', null]) for (const isTraining of [false,true]) {
    const html = render({ tsunamiWarningActive:true, tsunamiWarningColor:color,
      tsunamiWarningText:'津波警報', isTraining, isTestData:!isTraining, rows:[], headline:'津波警報' });
    assert.ok(html.includes(`--tsunami-warning-color:${color || '#00a0e9'};border-left-color:var(--tsunami-warning-color)`));
    assert.ok(html.includes('class="tsunami-alert-banner" style="background:var(--tsunami-warning-color)"'));
  }
});

test('merged earthquake and tsunami cards retain the strongest tsunami banner color', () => {
  const merge = loadFunction('mergedCardForRecords', 'function groupOverlappingRecords(', {
    recordSeverityRank: () => 0, recordBadges: () => [], Map, Set,
  });
  const base = { rows:[], updatedAt:100, isTraining:true };
  const card = merge([{ ...base, headline:'震度速報' },
    { ...base, tsunamiWarningActive:true, tsunamiWarningColor:'#ff2800', tsunamiWarningText:'津波警報' },
    { ...base, tsunamiWarningActive:true, tsunamiWarningColor:'#c800c8', tsunamiWarningText:'大津波警報' }]);
  assert.equal(card.tsunamiWarningActive,true);
  assert.equal(card.tsunamiWarningColor,'#c800c8');
  assert.equal(card.tsunamiWarningText,'大津波警報');
});
