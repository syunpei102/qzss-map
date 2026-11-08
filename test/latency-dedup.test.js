const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deduplicateLatencyHistory } = require('../public/latency-dedup');

test('latency page keeps the first measurement of each packet', () => {
  const summary = { disaster_category_no: 1, seismic_epicenter: '千島列島' };
  const first = { recordedAt: 1, reportKey: 'dcr:aa:0', reportSummary: summary, totalMs: 100 };
  const duplicate = { recordedAt: 2, reportKey: 'dcr:aa:0', reportSummary: summary, totalMs: 120 };
  const updated = { recordedAt: 3, reportKey: 'dcr:bb:0', reportSummary: { ...summary, magnitude: '5.5' }, totalMs: 110 };
  const cancellation = { recordedAt: 4, reportKey: 'dcr:aa:2', reportSummary: { ...summary, information_type: '取消' }, totalMs: 90 };
  assert.deepEqual(Array.from(deduplicateLatencyHistory([first, duplicate, updated, cancellation])),
    [first, updated, cancellation]);
});

test('same published quake with missing and changing raw keys keeps first measurement', () => {
  const reportSummary = { type: 'QzssDcReportJmaSeismicIntensity', report_time: '2026-11-08T01:56:00', disaster_category_no: 3 };
  const first = { recordedAt: 1000, reportSummary };
  const later = { recordedAt: 1800000, reportSummary: { ...reportSummary }, reportKey: 'dcr:aa:0' };
  const resent = { recordedAt: 3600000, reportSummary: { ...reportSummary }, reportKey: 'dcr:bb:0' };
  assert.deepEqual(deduplicateLatencyHistory([first, later, resent]), [first]);
});

test('different regions and later DCX broadcasts are retained', () => {
  const base = { type: 'QzssDcxJAlert', a4_hazard_type: 'Test alert' };
  const first = { recordedAt: 1000, reportSummary: { ...base, ex1_target_area_ja: '東京都' } };
  const duplicate = { recordedAt: 2000, reportSummary: { ...base, ex1_target_area_ja: '東京都' } };
  const other = { recordedAt: 3000, reportSummary: { ...base, ex1_target_area_ja: '大阪府' } };
  const later = { recordedAt: 3601000, reportSummary: { ...base, ex1_target_area_ja: '東京都' } };
  assert.deepEqual(deduplicateLatencyHistory([first, duplicate, other, later]), [first, other, later]);
});

test('legacy rows collapse by visible summary while test and live remain separate', () => {
  const summary = { disaster_category_no: 5, report_time: '2026-11-08T00:00:00Z' };
  const first = { recordedAt: 1, reportSummary: summary, isTestData: false };
  const duplicate = { recordedAt: 2, reportSummary: { ...summary }, isTestData: false };
  const testRow = { recordedAt: 3, reportSummary: summary, isTestData: true };
  assert.deepEqual(Array.from(deduplicateLatencyHistory([first, duplicate, testRow])), [first, testRow]);
});
