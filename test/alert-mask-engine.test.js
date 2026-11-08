const { test } = require('node:test');
const assert = require('node:assert/strict');
const AlertMaskEngine = require('../public/alert-mask-engine');

test('updates only changed region colors and clears removed warnings', () => {
  const calls = [];
  const map = {
    setFeatureState: (target, state) => calls.push(['set', target, state]),
    removeFeatureState: (target, key) => calls.push(['remove', target, key]),
  };
  const engine = new AlertMaskEngine(map);
  assert.equal(engine.sync('prefecture-regions', new Map([[13, '#ff0000'], [14, '#ff0000']])), 2);
  assert.equal(engine.sync('prefecture-regions', new Map([[13, '#ff0000'], [14, '#ff0000']])), 0);
  assert.equal(engine.sync('prefecture-regions', new Map([[13, '#800080']])), 2);
  assert.deepEqual(calls.at(-2), ['remove', { source: 'prefecture-regions', id: 14 }, 'color']);
  assert.deepEqual(calls.at(-1), ['set', { source: 'prefecture-regions', id: 13 }, { color: '#800080' }]);
  assert.equal(engine.sync('weather-regions', new Map([[11000, '#ffff00']])), 1);
  assert.equal(engine.sync('prefecture-regions', new Map()), 1);
});

test('sources with the same region id stay independent', () => {
  const calls = [];
  const engine = new AlertMaskEngine({ setFeatureState: (target) => calls.push(target), removeFeatureState() {} });
  engine.sync('prefecture-regions', new Map([[1, 'red']]));
  engine.sync('weather-regions', new Map([[1, 'yellow']]));
  assert.deepEqual(calls, [{ source: 'prefecture-regions', id: 1 }, { source: 'weather-regions', id: 1 }]);
});
