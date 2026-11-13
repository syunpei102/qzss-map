const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EEW_FILL_TTL_MS, fromReport, merge, expire } = require('../public/earthquake-fill');

const eew = (extras = {}) => ({ disaster_category_no: 1, ...extras });
const intensity = { disaster_category_no: 3 };
const red = [{ id: 1, color: '#ff2800' }, { id: 2, color: '#ff2800' }];
const observed = [{ id: 1, color: '#dbb85c', label: '4' }];

test('observed intensity replaces every EEW region, including areas without an observation', () => {
  const state = merge(fromReport(eew(), red, 0), fromReport(intensity, observed, 1000));
  assert.equal(state.phase, 'observed');
  assert.deepEqual(state.prefectures, observed);
  assert.deepEqual(merge(state, fromReport(eew(), red, 2000)).prefectures, observed,
    'a later EEW or replay must not restore the red areas');
});

test('an intensity report with no prefectures still clears all EEW fill', () => {
  const state = merge(fromReport(eew(), red, 0), fromReport(intensity, [], 1000));
  assert.equal(state.phase, 'observed');
  assert.deepEqual(state.prefectures, []);
  assert.deepEqual(merge(state, fromReport(eew(), red, 2000)).prefectures, []);
});

test('EEW fill expires ten minutes after the first receipt age, independently of its card', () => {
  let state = fromReport(eew(), red, 0);
  assert.equal(state.deadline, EEW_FILL_TTL_MS);
  state = merge(state, fromReport(eew(), red, 60_000));
  assert.equal(state.deadline, EEW_FILL_TTL_MS + 60_000);
  assert.equal(expire(state, EEW_FILL_TTL_MS + 59_999).phase, 'eew');
  assert.deepEqual(expire(state, EEW_FILL_TTL_MS + 60_000).prefectures, []);
});

test('reconnect uses original reception age instead of restarting ten minutes', () => {
  const recent = fromReport(eew({ replay_age_ms: 4 * 60_000 }), red, 1_000_000);
  assert.equal(recent.deadline, 1_000_000 + EEW_FILL_TTL_MS - 4 * 60_000);
  const stale = fromReport(eew({ replay_age_ms: EEW_FILL_TTL_MS }), red, 1_000_000);
  assert.equal(stale.phase, 'expired');
  assert.deepEqual(stale.prefectures, []);
});

test('new EEW focus preserves existing tsunami line and blinking but hides older intensity', () => {
  const source=fs.readFileSync(require.resolve('../public/main.js'),'utf8');
  const start=source.indexOf('  const eewPriority = hasVisibleEewFill();',source.indexOf('function syncActiveEventLayers('));
  const end=source.indexOf("  if (map.getLayer('flood-river-line'))",start);
  const fresh={id:1,geo:{tsunami:[],prefectures:[{id:1,color:'red'}]},badgeClass:'sev-warning'};
  const coast={id:2,geo:{tsunami:[{code:123,color:'purple'}],prefectures:[]},tsunamiWarningActive:true,badgeClass:'sev-warning'};
  const old={id:3,geo:{tsunami:[],prefectures:[{id:2,color:'yellow'}]},badgeClass:'sev-warning'};
  const result=vm.runInNewContext(`let tsunamiActive=false;const tsunamiColorByCode=new Map(),prefColorById=new Map(),tokyoParts=new Set(),municipalityColorByCode=new Map(),floodRiverColorByCode=new Map(),ellipseFeatures=[];let wholeTokyo=false;${source.slice(start,end)};({coasts:[...tsunamiColorByCode.keys()],prefectures:[...prefColorById.keys()],blink:tsunamiActive})`,{
    activeEvents:new Map([[1,fresh],[2,coast],[3,old]]),otherReports:new Map(),focusedQuake:fresh,visibleIds:new Set([1,2]),
    hasVisibleEewFill:()=>true,isEarthquakeOrTsunamiRecord:r=>r===fresh||r===coast,
    SEVERITY_RANK:{'sev-warning':2},cardSeverityClass:()=> 'sev-warning',
    setIfMoreSevere:(map,key,color)=>map.set(key,{color}),Date,
  });
  assert.deepEqual(Array.from(result.coasts),[123]);
  assert.deepEqual(Array.from(result.prefectures),[1]);
  assert.equal(result.blink,true);
});
