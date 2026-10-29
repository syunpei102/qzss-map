const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/main.js'), 'utf8');
const start = source.indexOf('function tsunamiGuidance(');
const end = source.indexOf('// ==================================================', start);
assert.ok(start >= 0 && end > start);
const buildSummary = vm.runInNewContext(`${source.slice(start, end)}; buildSummary`, {
  formatDateTime: (value) => value,
  summarizeList: (values) => values.join('・'),
});

function notice(report) {
  return buildSummary(report).find(([label]) => label === 'お知らせ')?.[1];
}

test('tsunami warning and major warning show brief evacuation guidance only once', () => {
  for (const [code, label] of [[3, '津波警報'], [4, '大津波警報'], [5, '大津波警報']]) {
    const report = {
      disaster_category_no: 5,
      tsunami_warning_code_raw: code,
      tsunami_warning_code: label,
      tsunami_forecast_regions: ['宮城県'],
      tsunami_heights: ['3m'],
      notifications_on_disaster_prevention: ['長い原文．'.repeat(100)],
    };
    const rows = buildSummary(report);
    assert.match(notice(report), /沿岸部・川沿い.*高台や避難ビル/);
    assert.ok(!notice(report).includes('長い原文'));
    assert.equal(rows.filter(([key]) => key === 'お知らせ').length, 1);
    assert.ok(rows.some(([key, value]) => key === '対象沿岸' && value === '宮城県'));
    assert.ok(rows.some(([key, value]) => key === '津波の高さ' && value === '3m'));
  }
});

test('advisory gives shore guidance without warning-level evacuation instruction', () => {
  const text = notice({ disaster_category_no: 5, tsunami_warning_code_raw: 15,
    tsunami_warning_code: '津波注意報', notifications_on_disaster_prevention: ['長い原文．'.repeat(100)] });
  assert.match(text, /海から上がり.*海岸から離れて/);
  assert.ok(!text.includes('高台'));
  assert.ok(!text.includes('長い原文'));
});

test('resolution has no stale evacuation instruction and unknown status stays conservative', () => {
  const base = { disaster_category_no: 5, tsunami_warning_code_raw: 3,
    tsunami_warning_code: '津波警報', notifications_on_disaster_prevention: ['避難してください．'] };
  assert.equal(notice({ ...base, tsunami_warning_code_raw: 2 }), undefined);
  assert.equal(notice({ ...base, information_type_no: 2 }), undefined);
  assert.equal(notice({ ...base, information_type: '解除' }), undefined);
  assert.match(notice({ ...base, tsunami_warning_code_raw: 15, tsunami_warning_code: 'その他の警報' }), /最新の津波情報/);
});

test('other disasters keep their original notice and training uses the same tsunami guidance', () => {
  assert.equal(notice({ disaster_category_no: 1,
    notifications_on_disaster_prevention: ['強い揺れに警戒してください．'] }), '強い揺れに警戒してください．');
  assert.match(notice({ disaster_category_no: 5, report_classification_no: 7,
    tsunami_warning_code_raw: 3, tsunami_warning_code: '津波警報' }), /高台や避難ビル/);
});
