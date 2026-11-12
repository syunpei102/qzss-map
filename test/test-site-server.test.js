const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createTestSiteServer } = require('../scripts/test-site-server');

test('standalone test site serves only files and rejects writes and WebSockets', async t => {
  const server = createTestSiteServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = await fetch(base, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/test.html');
  assert.equal((await fetch(base+'/test.html')).status, 200);
  assert.equal((await fetch(base+'/index.html?sandbox=1')).status, 200);
  assert.equal((await fetch(base+'/config')).status, 404);
  assert.equal((await fetch(base+'/ingest', { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await fetch(base+'/%2e%2e%2fVERSION')).status, 404);
  const socket = new WebSocket(base.replace('http:', 'ws:'));
  await assert.rejects(once(socket, 'open'), /403/);
  socket.terminate();
});
