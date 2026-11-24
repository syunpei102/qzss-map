const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EarthquakeReceptions, TsunamiRevisions, updateActiveReports} = require('../report-state');
const {EventStore} = require('../public/display-events');

test('cancelled EEW stays cancelled after restart while the observed intensity can arrive', () => {
  const quake = {disaster_category_no:1, occurrence_time_of_earthquake:'2026-11-24T10:00:00Z',
    seismic_epicenter_raw:510, information_type_no:0};
  const history = new EarthquakeReceptions();
  history.observe(quake, 1000);
  const cancel = {...quake, information_type_no:2};
  assert.equal(history.cancel(cancel, 61000), true);
  const restarted = new EarthquakeReceptions(JSON.parse(JSON.stringify(history.entries)));
  assert.equal(restarted.observe(quake, 302000).rejected, true);
  assert.equal(restarted.observe({...quake, disaster_category_no:3}, 302000).rejected, undefined);
  assert.equal(restarted.observe({...quake, occurrence_time_of_earthquake:'2026-11-24T10:05:00Z'}, 302000).rejected, undefined);
  let now = 1000;
  const browser = new EventStore({now:()=>now, setTimer:()=>0, clearTimer:()=>{}});
  browser.receive(quake);
  now = 61000;
  browser.receive(cancel);
  now = 302000;
  assert.deepEqual(browser.receive(quake), []);
  assert.equal(browser.events.size, 0);
});

test('old tsunami updates and cancellations cannot change newer regions', () => {
  const warning = {disaster_category_no:5, report_time:'2026-11-24T10:05:00',
    tsunami_forecast_regions_raw:[100], tsunami_heights:['3m']};
  const old = {...warning, report_time:'2026-11-24T10:00:00', tsunami_heights:['1m']};
  const ledger = new TsunamiRevisions();
  ledger.accept(warning);
  const persisted = JSON.parse(JSON.stringify([...ledger.entries]));
  const restored = new TsunamiRevisions(persisted);
  assert.equal(restored.accept(old), null);
  assert.equal(restored.accept({...old, information_type_no:2}), null);
  assert.equal(restored.accept({...old, information_type_no:2, tsunami_forecast_regions_raw:[]}), null);
  const accepted = restored.accept({...old, tsunami_forecast_regions_raw:[100, 200], tsunami_heights:['1m','2m']});
  assert.deepEqual(accepted.tsunami_forecast_regions_raw, [200]);
  assert.deepEqual(accepted.tsunami_heights, ['2m']);
  const current = updateActiveReports([], warning, 1000, false);
  assert.deepEqual(updateActiveReports(current, old, 2000, false), current);
  assert.deepEqual(updateActiveReports(current, {...old, information_type_no:2}, 2000, true), current);
  restored.accept({...warning, report_time:'2026-11-24T10:06:00', information_type_no:2});
  assert.equal(restored.accept(warning), null);
});
