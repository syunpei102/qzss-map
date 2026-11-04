const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setDataIfChanged, setFilterIfChanged, setPaintIfChanged } = require('../public/map-source-cache');

test('unchanged geometry skips MapLibre update, but changed data and a recreated source update', () => {
  const sent = [];
  const source = { setData: (data) => sent.push(data) };
  let built = 0;
  const makeData = () => { built++; return { features: [built] }; };
  assert.equal(setDataIfChanged(source, 'area:1', makeData), true);
  assert.equal(setDataIfChanged(source, 'area:1', makeData), false);
  assert.equal(built, 1);
  assert.equal(setDataIfChanged(source, 'area:2', makeData), true);
  assert.deepEqual(sent, [{ features: [1] }, { features: [2] }]);

  const newSource = { setData: (data) => sent.push(data) };
  assert.equal(setDataIfChanged(newSource, 'area:2', makeData), true);
  assert.equal(built, 3);
});

test('a failed source update is retried on the next call', () => {
  let calls = 0;
  const source = { setData() { if (++calls === 1) throw new Error('source not ready'); } };
  assert.throws(() => setDataIfChanged(source, 'area:1', {}), /not ready/);
  assert.equal(setDataIfChanged(source, 'area:1', {}), true);
  assert.equal(calls, 2);
});

test('unchanged filters and colors skip style updates; changed values and recreated layers apply', () => {
  const calls = [];
  let layer = {};
  const map = {
    getLayer: () => layer,
    setFilter: (id, value) => calls.push(['filter', id, value]),
    setPaintProperty: (id, property, value) => calls.push(['paint', id, property, value]),
  };
  const filter = ['in', ['get', 'id'], ['literal', [1]]];
  assert.equal(setFilterIfChanged(map, 'prefecture-fill', filter), true);
  assert.equal(setFilterIfChanged(map, 'prefecture-fill', [...filter]), false);
  assert.equal(setPaintIfChanged(map, 'prefecture-fill', 'fill-color', '#ff0000'), true);
  assert.equal(setPaintIfChanged(map, 'prefecture-fill', 'fill-color', '#ff0000'), false);
  assert.equal(setPaintIfChanged(map, 'prefecture-fill', 'fill-color', '#990000'), true);
  layer = {};
  assert.equal(setFilterIfChanged(map, 'prefecture-fill', filter), true);
  assert.equal(calls.length, 4);
});
