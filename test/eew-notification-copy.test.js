const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = server.indexOf('function notificationBodyFor(report) {');
const end = server.indexOf('function notificationBodyDetail(report) {', start);
assert.ok(start !== -1 && end > start);
const notificationBodyFor = vm.runInNewContext(
  `${server.slice(start, end)}; notificationBodyFor`,
  { notificationBodyDetail: () => 'other category' },
);

test('EEW push names the epicenter and predicted upper intensity', () => {
  assert.equal(notificationBodyFor({
    disaster_category_no: 1,
    seismic_epicenter: '千島列島',
    seismic_intensity_upper_limit: '震度7',
    magnitude: '9.9',
  }), '千島列島で地震．予想最大震度7．');
});

test('EEW push does not mislabel the lower bound as the maximum', () => {
  assert.equal(notificationBodyFor({
    disaster_category_no: 1,
    seismic_epicenter: '日向灘',
    seismic_intensity_lower_limit: '震度5弱',
  }), '日向灘で地震．');
});

test('EEW push handles missing epicenter and cancellation', () => {
  assert.equal(notificationBodyFor({
    disaster_category_no: 1,
    seismic_intensity_upper_limit: '震度6強',
  }), '震源地を確認中．予想最大震度6強．');
  assert.equal(notificationBodyFor({
    disaster_category_no: 1,
    information_type_no: 2,
    seismic_epicenter: '千島列島',
    seismic_intensity_upper_limit: '震度7',
  }), '千島列島の緊急地震速報を取り消しました．');
});

test('other notification bodies retain their existing formatter', () => {
  assert.equal(notificationBodyFor({ disaster_category_no: 5 }), 'other category');
});
