const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/main.js'), 'utf8');
const start = source.indexOf('function latestIntensityBadgeMarkers(');
const end = source.indexOf('// 警報対象地域の塗りつぶしを先に', start);
function marker(id, position) {
  const element = { style: {} };
  return { __prefectureId: id, __basePos: position, getElement: () => element,
    setLngLat(value) { this.position = [...value]; } };
}
test('nearby intensity markers keep their prefecture coordinates at all zooms', () => {
  const a = marker(40, [130.5, 33.5]); const b = marker(41, [130.51, 33.51]);
  const record = { id: 1, updatedAt: 100, markers: { intensityBadges: [a, b] }, geo: { hypocenter: { lon: 130.5, lat: 33.5 } } };
  let zoom = 3;
  const context = { Map, Set, map: { getZoom: () => zoom,
      project: ([x, y]) => ({ x: x * 2 ** zoom, y: y * 2 ** zoom }),
      unproject: ([x, y]) => [x / 2 ** zoom, y / 2 ** zoom] },
    activeEvents: new Map([[1, record]]), quakeLockRecords: () => [record] };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  for (zoom of [3, 6, 10, 2.5, 8, 3]) {
    context.syncIntensityBadgeAnchors();
    assert.deepEqual(a.position, a.__basePos);
    assert.deepEqual(b.position, b.__basePos);
  }
});
test('latest prefecture visibility and focused event filtering survive fixed anchoring', () => {
  const older = marker(40, [130.5, 33.5]), newer = marker(40, [130.5, 33.5]), other = marker(41, [130.3, 33.3]);
  const a = { id: 1, updatedAt: 100, markers: { intensityBadges: [older, other] } };
  const b = { id: 2, updatedAt: 200, markers: { intensityBadges: [newer] } };
  let focused = [];
  const context = { Map, Set, map: {}, activeEvents: new Map([[1,a],[2,b]]), quakeLockRecords: () => focused };
  vm.createContext(context); vm.runInContext(source.slice(start,end),context);
  context.syncIntensityBadgeAnchors();
  assert.equal(older.getElement().style.display,'none');assert.equal(newer.getElement().style.display,'');assert.equal(other.getElement().style.display,'');
  focused=[a];context.syncIntensityBadgeAnchors();
  assert.equal(older.getElement().style.display,'');assert.equal(newer.getElement().style.display,'none');
});
