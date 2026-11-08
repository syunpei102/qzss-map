const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TileStore, mercator, lngLat, evaluate, pointInRing, pointNearLine } = require('../public/native-map');
const { decodeGeometry, tileRange } = require('../scripts/build-native-tiles');

test('MVT geometry commands preserve delta coordinates and rings', () => {
  // MoveTo(2,3), LineTo(5,3), LineTo(5,7), ClosePath
  const encoded = Uint8Array.of(9, 4, 6, 18, 6, 0, 0, 8, 15);
  assert.deepEqual(decodeGeometry(encoded), [[2, 3, 5, 3, 5, 7]]);
});

test('generated native archive contains all 95 source tiles and both polygon and line geometry', () => {
  const file = fs.readFileSync(path.join(__dirname, '../public/data/native-base-tiles.bin'));
  const store = new TileStore(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  assert.equal(store.index.size, 95);
  const all = [...store.index.keys()].map(key => store.tile(...key.split('/').map(Number)));
  assert.ok(all.some(t => t.AdmArea.features.some(f => f.type === 3 && f.paths.length)));
  assert.ok(all.some(t => t.Cstline.features.some(f => f.type === 2 && f.paths.length)));
  assert.ok(all.some(t => t.AdmBdry.features.some(f => f.type === 2 && f.paths.length)));
  assert.ok(all.every(t => Object.values(t).every(l => l.extent > 0)));
});

test('Mercator conversion and tile range cover Japan', () => {
  const point = [139.7, 35.7];
  const back = lngLat(mercator(point));
  assert.ok(Math.abs(back[0] - point[0]) < 1e-8);
  assert.ok(Math.abs(back[1] - point[1]) < 1e-8);
  const range = tileRange(122, 17, 154, 46, 4);
  assert.ok(range.minX <= range.maxX && range.minY <= range.maxY);
});

test('native filter and color expressions support alert layers', () => {
  const filter = ['in', ['get', 'code'], ['literal', [11000, 12000]]];
  assert.equal(evaluate(filter, { code: 11000 }, 5), true);
  assert.equal(evaluate(filter, { code: 13000 }, 5), false);
  const color = ['match', ['get', 'code'], 11000, '#ff0000', 12000, '#800080', '#999999'];
  assert.equal(evaluate(color, { code: 12000 }, 5), '#800080');
  assert.equal(evaluate(['interpolate', ['linear'], ['zoom'], 4, 6, 7, 10], {}, 5.5), 8);
});

test('click hit testing handles polygon holes and thin tsunami lines', () => {
  const outer = [[0, 0], [2, 0], [2, 2], [0, 2]];
  const hole = [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5]];
  assert.equal(pointInRing([0.2, 0.2], outer) !== pointInRing([0.2, 0.2], hole), true);
  assert.equal(pointInRing([1, 1], outer) !== pointInRing([1, 1], hole), false);
  assert.equal(pointNearLine([1, 0.02], [[0, 0], [2, 0]], 0.03), true);
  assert.equal(pointNearLine([1, 0.2], [[0, 0], [2, 0]], 0.03), false);
});
