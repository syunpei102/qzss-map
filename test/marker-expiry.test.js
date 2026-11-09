const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/main.js'), 'utf8');
const start = source.indexOf('function scheduleActiveEventExpiry(');
const end = source.indexOf('function addActiveEvent(', start);
function harness() {
  let now = 0;
  const timers = new Map(); let next = 1;
  const removed = [];
  const context = { Date: { now: () => now }, Math, activeEvents: new Map(),
    clearTimeout: id => timers.delete(id),
    setTimeout: (callback, ms) => { const id = next++; timers.set(id, { callback, at: now + ms }); return id; },
    removeActiveEvent: id => removed.push(id),
    syncActiveEventLayers: () => {}, resolveMarkerOverlaps: () => {}, renderEventsPanel: () => {},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { context, timers, removed, advance(ms) { now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  }};
}
test('tsunami merge never extends quake geometry, including an already expired replay', () => {
  const h = harness(); let badgeRemoved = false;
  const record = { id: 1, earthquakeGeoExpiresAt: 20 * 60_000,
    geo: { hypocenter: { lon: 142, lat: 38 }, prefectures: [{ id: 1 }], tsunami: [{ code: 100 }] },
    markers: { intensityBadges: [{ remove() { badgeRemoved = true; } }] } };
  h.context.activeEvents.set(1, record);
  h.context.scheduleActiveEventExpiry(record, { expiresAt: 20 * 60_000 }, 20 * 60_000);
  h.context.scheduleEarthquakeGeoExpiry(record);
  h.advance(19 * 60_000);
  h.context.scheduleActiveEventExpiry(record, { expiresAt: 24 * 3600_000 }, 24 * 3600_000);
  h.context.scheduleEarthquakeGeoExpiry(record);
  h.advance(60_000);
  assert.equal(record.geo.hypocenter, null);
  assert.equal(record.geo.prefectures.length, 0);
  assert.equal(badgeRemoved, true);
  assert.equal(record.geo.tsunami.length, 1);
  assert.equal(h.removed.length, 0);
  record.geo.hypocenter = { lon: 142, lat: 38 };
  h.context.scheduleEarthquakeGeoExpiry(record);
  assert.equal(record.geo.hypocenter, null);
});
test('shorter followup cannot restart the long tsunami lifetime', () => {
  const h = harness(); const record = { id: 1 };
  h.context.scheduleActiveEventExpiry(record, { expiresAt: 100_000 }, 100_000);
  h.advance(90_000);
  h.context.scheduleActiveEventExpiry(record, { expiresAt: 95_000 }, 5_000);
  assert.equal(record.expiresAt, 100_000);
  h.advance(10_000);
  assert.deepEqual(h.removed, [1]);
});
test('zero remaining TTL expires immediately instead of becoming permanent', () => {
  const h = harness(); const record = { id: 1 };
  h.context.scheduleActiveEventExpiry(record, {}, 0);
  h.advance(0);
  assert.deepEqual(h.removed, [1]);
});
test('intensity badges have a fixed screen size at every zoom', () => {
  const fn = source.slice(source.indexOf('function intensityBadgeScaleForZoom('), source.indexOf('function applyIntensityBadgeScale('));
  const scale = vm.runInNewContext(fn + '; intensityBadgeScaleForZoom');
  for (const zoom of [2.5, 4, 6, 9, 14, 18]) assert.equal(scale(zoom), 1);
});

test('native renderer honors image pixelRatio and keeps icon pixels constant across zooms', () => {
  const { NativeMap } = require('../public/native-map');
  const oldCanvas = global.HTMLCanvasElement;
  const oldImage = global.HTMLImageElement;
  class Canvas {}
  global.HTMLCanvasElement = Canvas;
  global.HTMLImageElement = Canvas;
  try {
    for (const dpr of [1, 2]) for (const zoom of [3, 6, 10]) {
      let transform = 1; const stack = []; let paintedWidth;
      const image = Object.assign(new Canvas(), { width: 56, height: 56 });
      const map = Object.assign(Object.create(NativeMap.prototype), {
        zoom, dpr, center: [142, 38], width: 800, height: 600, images: new Map(), requestRender() {},
        sources: new Map([['points', { data: { features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [142, 38] } }] } }]]),
        ctx: { save() { stack.push(transform); }, restore() { transform = stack.pop(); },
          setTransform(a) { transform = a; }, translate() {}, scale(x) { transform *= x; },
          drawImage(img, x, y, width) { paintedWidth = width * transform / dpr; } },
      });
      map.addImage('cross', image, { pixelRatio: 2 });
      map.drawGeoLayer({ type: 'symbol', source: 'points', layout: { 'icon-image': 'cross', 'icon-size': 1 } });
      assert.equal(paintedWidth, 28, `zoom=${zoom}, dpr=${dpr}`);
    }
  } finally {
    global.HTMLCanvasElement = oldCanvas;
    global.HTMLImageElement = oldImage;
  }
});
