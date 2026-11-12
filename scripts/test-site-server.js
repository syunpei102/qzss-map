// 独立したテストサイトの静的ファイル配信専用．受信API・WebSocketは実装しない．
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream');
const root = path.resolve(__dirname, '../public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/geo+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.ico': 'image/x-icon' };
function createTestSiteServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    let url, name;
    try { url = new URL(req.url, 'http://localhost'); name = decodeURIComponent(url.pathname); }
    catch { res.writeHead(400); return res.end(); }
    if (name === '/' || (name === '/index.html' && url.searchParams.get('sandbox') !== '1')) {
      res.writeHead(302, { Location: '/test.html', 'Cache-Control': 'no-store' }); return res.end();
    }
    const file = path.resolve(root, '.' + name);
    if (!file.startsWith(root + path.sep) || name.includes('\0') || !types[path.extname(file)]) {
      res.writeHead(404); return res.end();
    }
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) { res.writeHead(404); return res.end(); }
      const etag = `"${stat.size}-${stat.mtimeMs}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', name.startsWith('/data/') ? 'public, max-age=86400' : 'no-cache');
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
      res.setHeader('Content-Type', types[path.extname(file)]);
      if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
      const input = fs.createReadStream(file);
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && !['.png', '.ico'].includes(path.extname(file))) {
        res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding');
        pipeline(input, zlib.createGzip(), res, () => {});
      } else pipeline(input, res, () => {});
    } catch { res.writeHead(404); res.end(); }
  });
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  return server;
}
if (require.main === module) createTestSiteServer().listen(Number(process.env.PORT || 8080), process.env.HOST || '0.0.0.0');
module.exports = { createTestSiteServer };
