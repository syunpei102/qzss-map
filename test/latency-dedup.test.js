const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'latency.html'), 'utf8');
const start = html.indexOf('function deduplicateLatencyHistory(history) {');
const end = html.indexOf('function percentile(', start);
assert.ok(start !== -1 && end > start);
const deduplicateLatencyHistory = vm.runInNewContext(
  `${html.slice(start, end)}; deduplicateLatencyHistory`,
);

test('latency page keeps the first measurement of each packet', () => {
  const summary = { disaster_category_no: 1, seismic_epicenter: '千島列島' };
  const first = { recordedAt: 1, reportKey: 'dcr:aa:0', reportSummary: summary, totalMs: 100 };
  const duplicate = { recordedAt: 2, reportKey: 'dcr:aa:0', reportSummary: summary, totalMs: 120 };
  const updated = { recordedAt: 3, reportKey: 'dcr:bb:0', reportSummary: summary, totalMs: 110 };
  const cancellation = { recordedAt: 4, reportKey: 'dcr:aa:2', reportSummary: summary, totalMs: 90 };
  assert.deepEqual(Array.from(deduplicateLatencyHistory([first, duplicate, updated, cancellation])),
    [first, updated, cancellation]);
});

test('legacy rows collapse by visible summary while test and live remain separate', () => {
  const summary = { disaster_category_no: 5, report_time: '2026-11-08T00:00:00Z' };
  const first = { recordedAt: 1, reportSummary: summary, isTestData: false };
  const duplicate = { recordedAt: 2, reportSummary: { ...summary }, isTestData: false };
  const testRow = { recordedAt: 3, reportSummary: summary, isTestData: true };
  assert.deepEqual(Array.from(deduplicateLatencyHistory([first, duplicate, testRow])), [first, testRow]);
});
