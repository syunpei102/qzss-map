const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publicDir = path.join(__dirname, '../public');

function sandbox(search = '?sandbox=1') {
  const requests = [], listeners = {}, messages = [];
  const parent = { postMessage: data => messages.push(data) };
  const window = { parent, fetch: async (...args) => { requests.push(args); return new Response('{}'); },
    addEventListener: (type, listener) => { listeners[type] = listener; } };
  const location = { search, hash: '#nonce', href: `http://localhost/${search}#nonce`, origin: 'http://localhost' };
  const originalWebSocket = function () {};
  window.WebSocket = originalWebSocket;
  const navigator = { sendBeacon: () => true };
  vm.runInNewContext(fs.readFileSync(path.join(publicDir, 'test-sandbox.js'), 'utf8'),
    { window, location, navigator, URL, URLSearchParams, Response });
  return { window, requests, messages, listeners, parent, navigator, originalWebSocket };
}

test('test sandbox blocks server writes and real WebSockets while allowing map assets', async () => {
  const s = sandbox();
  await assert.rejects(s.window.fetch('/ingest', { method: 'POST', body: '{}' }), /書込み/);
  await assert.rejects(s.window.fetch(new Request('http://localhost/client-timing', { method: 'POST' })), /書込み/);
  assert.throws(() => new s.window.WebSocket('wss://example.com'), /接続しません/);
  assert.equal(s.navigator.sendBeacon('/client-timing', '{}'), false);
  const config = await (await s.window.fetch('/config')).json();
  assert.equal(config.showTrainingBroadcasts, false);
  assert.equal(config.weatherEnabled, false);
  assert.equal(s.requests.length, 0);
  await s.window.fetch('./data/prefectures.geojson');
  assert.equal(s.requests.length, 1);
});

test('commands require parent, matching origin and nonce and always become test data', async () => {
  const s = sandbox();
  const applied = [];
  s.window.QzssSandbox.attach(async command => { applied.push(command); return []; }, Promise.resolve());
  const command = { type: 'qzss-test-command', token: 'nonce', id: 1, reports: [{ is_test_data: false, client_timestamps: {} }] };
  await s.listeners.message({ source: {}, origin: 'http://localhost', data: command });
  await s.listeners.message({ source: s.parent, origin: 'https://other.example', data: command });
  await s.listeners.message({ source: s.parent, origin: 'http://localhost', data: { ...command, token: 'wrong' } });
  assert.equal(applied.length, 0);
  await s.listeners.message({ source: s.parent, origin: 'http://localhost', data: command });
  assert.equal(applied.length, 1);
  assert.equal(applied[0].reports[0].is_test_data, true);
  assert.equal(applied[0].reports[0].client_timestamps, undefined);
});

test('sandbox bootstrap leaves the normal map transport unchanged', () => {
  const s = sandbox('');
  assert.equal(s.window.WebSocket, s.originalWebSocket);
  assert.equal(s.window.QzssSandbox, undefined);
});

test('four scenarios include a coherent four-report Nankai earthquake sequence', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(publicDir, 'test-cases.js'), 'utf8'), { window });
  assert.equal(window.QzssTestCases.length, 4);
  const sequence = window.QzssTestCases.find(c => c.id === 'nankai');
  assert.deepEqual(Array.from(sequence.steps, step => step.report.disaster_category_no), [1, 2, 3, 5]);
  assert.equal(new Set(sequence.steps.map(step => JSON.stringify(step.report.coordinates_of_hypocenter))).size, 1);
  for (const entry of window.QzssTestCases) for (const step of entry.steps) assert.equal(step.report.is_test_data, true);
});
