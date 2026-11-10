const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ReportTtl = require('../public/report-ttl');
const source = fs.readFileSync(require.resolve('../public/main.js'), 'utf8');
const start = source.indexOf("socket.addEventListener('message', async (event) => {");
const end = source.indexOf('    const timingSequence =', start);
assert.ok(start >= 0 && end > start);
const listenerSource = source.slice(start, end) + '\n});';

for (const classification of [1, 7]) for (const replayAge of [0, 240_000, ReportTtl.TTL.EEW - 500]) {
  test(`websocket reception preserves remaining lifetime: classification=${classification}, replayAge=${replayAge}`, async () => {
    let listener, rendered, mono = 2000, ready;
    const mapReady = new Promise(resolve => { ready = resolve; });
    const context = {
      socket: { addEventListener(type, fn) { assert.equal(type, 'message'); listener = fn; } },
      performance: { now: () => mono }, Date: { now: () => 1_794_280_000_000 },
      console: { log() {} }, mapReady,
      renderReport(report) { rendered = report; },
    };
    vm.runInNewContext(listenerSource, context);
    const pending = listener({ data: JSON.stringify({ type: 'QzssDcReportJmaEarthquakeEarlyWarning',
      disaster_category_no: 1, report_classification_no: classification, replay_age_ms: replayAge }) });
    assert.equal(rendered, undefined, 'wait for the map before rendering');
    mono += 1250; ready(); await pending;
    assert.equal(rendered.replay_age_ms, replayAge + 1250);
    assert.equal(ReportTtl.remainingTtlMsForReport(rendered), Math.max(0, ReportTtl.TTL.EEW - replayAge - 1250));
  });
}
