const { test } = require('node:test');
const assert = require('node:assert/strict');
const filter = require('../public/training-report-filter');

test('official earthquake and tsunami training follows the normal display path', () => {
  for (const category of [1, 2, 3]) {
    assert.equal(filter.shouldProcess({ report_classification_no: 7, disaster_category_no: category }), true);
  }
  for (const code of [1, 2, 3, 4, 5]) {
    assert.equal(filter.shouldProcess({ report_classification_no: 7, disaster_category_no: 5, tsunami_warning_code_raw: code }), true);
  }
  assert.equal(filter.shouldProcess({ report_classification_no: 7, disaster_category_no: 5, information_type_no: 2 }), true);
});

test('official training excludes advisories and unrelated categories but keeps J-Alert tests', () => {
  for (const category of [4, 6, 8, 9, 10, 11]) {
    assert.equal(filter.shouldProcess({ report_classification_no: 7, disaster_category_no: category }), false);
  }
  for (const code of [0, 6, 7, 15]) {
    assert.equal(filter.shouldProcess({ report_classification_no: 7, disaster_category_no: 5, tsunami_warning_code_raw: code }), false);
  }
  assert.equal(filter.shouldProcess({ a1_message_type: 'Test', type: 'QzssDcxLAlert' }), false);
  assert.equal(filter.shouldProcess({ a1_message_type: 'Test', type: 'QzssDcxMTInfo' }), false);
  assert.equal(filter.shouldProcess({ a1_message_type: 'Test', type: 'QzssDcxJAlert' }), true);
});

test('real reports and manual test data retain their existing behavior', () => {
  assert.equal(filter.shouldProcess({ report_classification_no: 1, disaster_category_no: 10 }), true);
  assert.equal(filter.shouldProcess({ report_classification_no: 1, disaster_category_no: 5, tsunami_warning_code_raw: 15 }), true);
  assert.equal(filter.shouldProcess({ type: 'QzssDcxJAlert', a1_message_type: 'Issue' }), true);
  assert.equal(filter.shouldProcess({ type: 'QzssDcxLAlert', a1_message_type: 'Issue' }), false);
  assert.equal(filter.shouldProcess({ is_test_data: true, disaster_category_no: 1 }), true);
  assert.equal(filter.shouldProcess({ a1_message_type: 'All Clear', type: 'QzssDcxLAlert' }), false);
});

test('training cancellation and tsunami resolution cannot clear live or manual test displays', () => {
  const training = { report_classification_no: 7 };
  const live = { report_classification_no: 1 };
  const manual = { is_test_data: true };
  assert.equal(filter.sameDisplayScope({ isTraining: true }, training), true);
  assert.equal(filter.sameDisplayScope({ isTraining: false }, training), false);
  assert.equal(filter.sameDisplayScope({ isTraining: true }, live), false);
  assert.equal(filter.sameDisplayScope({ isTestData: true }, training), false);
  assert.equal(filter.sameDisplayScope({ isTestData: true }, manual), true);
});
