const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Manager } = require('../public/lalert-display');

test('Lアラート0件では案内を出し，受信時に明細へ切り替え，設定OFFでは隠す', () => {
  const source = fs.readFileSync(require.resolve('../public/main.js'), 'utf8');
  const start = source.indexOf('function renderLAlertDisplay() {');
  const end = source.indexOf('\nsetInterval(() => {', start);
  assert.ok(start >= 0 && end > start);
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: id === 'lalert_banner' || id === 'lalert_fullscreen_overlay',
      classList: { values: new Set(), toggle(name, value) {
        if (value) this.values.add(name); else this.values.delete(name);
      }, remove(name) { this.values.delete(name); }, add(name) { this.values.add(name); } },
      textContent: '', className: '', offsetWidth: 100,
    });
    return elements.get(id);
  };
  const manager = new Manager({ now: () => 100000 });
  const context = vm.createContext({ document: { getElementById: get }, lalertManager: manager,
    lalertEnabled: true, lalertRenderedId: null, lalertRenderedRevision: -1,
    lalertRenderedListKey: '', lalertWasFullscreen: false, map: null,
    lalertTime: () => '12:00' });
  vm.runInContext(source.slice(start, end), context);
  context.renderLAlertDisplay();
  assert.equal(get('lalert_banner').hidden, false);
  assert.equal(get('lalert_banner').classList.values.has('is-empty'), true);
  assert.match(fs.readFileSync(require.resolve('../public/index.html'), 'utf8'), /表示中のLアラートはありません/);
  manager.receive({ type: 'QzssDcxLAlert', a1_message_type: 'Alert', a4_hazard_type: 'Flood',
    a5_severity: 'Severe', ex1_target_area_code_raw: 13201, ex1_target_area_ja: '東京都八王子市',
    a11_japanese_library_ja: '避難してください' });
  context.renderLAlertDisplay();
  assert.equal(get('lalert_banner').classList.values.has('is-empty'), false);
  assert.equal(get('lalert_message').textContent, '避難してください');
  context.lalertEnabled = false;
  context.renderLAlertDisplay();
  assert.equal(get('lalert_banner').hidden, true);
});
