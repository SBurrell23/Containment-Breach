/* Tiny static server for development.
 *
 * The only thing it does that `python -m http.server` does not is send
 * `Cache-Control: no-store`, so an edited .js file is actually picked up on the
 * next reload instead of being served from the browser's cache.
 *
 *   node tools/serve.js [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.argv[2], 10) || 8123;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml'
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';

  const full = path.join(ROOT, rel);
  // Refuse anything that escapes the project directory.
  if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + rel); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('Cave Typer dev server: http://localhost:' + PORT);
});
