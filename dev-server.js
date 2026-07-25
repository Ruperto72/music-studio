// Minimal static server for local development (no dependencies). ES modules
// need http:// (not file://), so run this and open http://localhost:8080.
//   node dev-server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;      // serve this folder (index.html, js/, songs/)
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  // Compare against ROOT + separator, not ROOT alone: a bare prefix check also
  // admits sibling directories whose name merely starts with it (a `..` path
  // resolving to `<root>-notes/secret`), which matters because this listens on
  // every interface.
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Music Studio on http://localhost:${PORT}`);
});
