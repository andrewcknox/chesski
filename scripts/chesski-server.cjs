const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { VAULT_PATH, sendJson, handleVaultApi } = require('./chesski-vault.cjs');
const { handleStockfishApi } = require('./chesski-stockfish.cjs');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const HOST = '127.0.0.1';
const PORT = Number(process.env.CHESSKI_PORT || 5173);

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.png') return 'image/png';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function serveStatic(req, res) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Chesski has not been built yet. Run npm run build, then start Chesski again.');
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const requested = path.resolve(DIST, `.${pathname}`);
  const safe = requested === DIST || requested.startsWith(DIST + path.sep);
  const filePath = safe && fs.existsSync(requested) && fs.statSync(requested).isFile()
    ? requested
    : path.join(DIST, 'index.html');
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Content-Length': body.length,
    'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (await handleStockfishApi(req, res)) return;
    if (await handleVaultApi(req, res, `http://${HOST}:${PORT}`)) return;
    serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    openBrowser(`http://${HOST}:${PORT}`);
    setTimeout(() => process.exit(0), 250);
    return;
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Chesski is running at ${url}`);
  console.log(`Local vault: ${VAULT_PATH}`);
  openBrowser(url);
});

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
}
