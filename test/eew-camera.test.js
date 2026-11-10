const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/main.js'), 'utf8');
function camera() {
  const box = [138, 35, 141, 37];
  const context = { JAPAN_VICINITY_BOUNDS: [100, 15, 170, 55],
    prefectureFeaturesById: new Map([[13, { geometry: box }]]), tsunamiFeaturesByCode: new Map([[1, { geometry: box }]]),
    mainLandBounds: x => x, geometryBounds: x => x, isMobileLayout: () => false,
    nearestCoastPoint: () => ({ point: [140, 35] }),
    unionBounds: boxes => [Math.min(...boxes.map(x => x[0])), Math.min(...boxes.map(x => x[1])),
      Math.max(...boxes.map(x => x[2])), Math.max(...boxes.map(x => x[3]))] };
  const start = source.indexOf('function earthquakeDisplayBounds(');
  vm.runInNewContext(source.slice(start, source.indexOf('// 最新の地震・津波1件', start)), context);
  return r => JSON.parse(JSON.stringify(context.earthquakeDisplayBounds(r)));
}
const event = (lon, lat, category = 1) => ({ disasterCategoryNo: category,
  geo: { hypocenter: { lon, lat }, prefectures: [{ id: 13 }], tsunami: [] } });
test('EEW includes a distant deep-earthquake origin and the entire warning region', () => {
  assert.deepEqual(camera()(event(140, 27.5)), [138, 27.5, 141, 37]);
  assert.deepEqual(camera()(event(150.84, 46.48)), [138, 35, 150.84, 46.48]);
});
test('EEW uses the same geometry for training and includes Japan-vicinity boundary origins', () => {
  for (const [lon, lat] of [[100, 15], [170, 55]]) {
    const r = { ...event(lon, lat), isTraining: true };
    assert.deepEqual(camera()(r), [Math.min(138, lon), Math.min(35, lat), Math.max(141, lon), Math.max(37, lat)]);
  }
});
test('distant origins preserve the existing affected-region camera policy', () => {
  for (const r of [event(180, 40), event(140, 60)]) {
    assert.deepEqual(camera()(r), [138, 35, 141, 37]);
  }
});
test('missing coordinates fit warning regions and origin-only reports still include the coast', () => {
  const r = event(140, 27.5); r.geo.hypocenter = null;
  assert.deepEqual(camera()(r), [138, 35, 141, 37]);
  const originOnly = event(140, 27.5); originOnly.geo.prefectures = [];
  assert.deepEqual(camera()(originOnly), [140, 27.5, 140, 35]);
});

test('EEW merged into an earlier hypocenter report still includes its origin', () => {
  const r = event(140, 27.5, 2);
  r.earthquakeFill = { phase: 'eew', cameraBounds: [138, 35, 141, 37] };
  assert.deepEqual(camera()(r), [138, 27.5, 141, 37]);
  r.earthquakeFill.phase = 'observed';
  assert.deepEqual(camera()(r), [138, 27.5, 141, 37]);
});
