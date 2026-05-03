const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const HOST = '127.0.0.1';
const PORT = Number(process.env.CHESSKI_PORT || 5173);
const VAULT_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Chesski');
const VAULT_PATH = path.join(VAULT_DIR, 'vault.json');

function emptyVault() {
  return {
    version: 1,
    accounts: [],
    currentAccountId: null,
    recoverySnapshots: [],
    lichessToken: null,
  };
}

function readVault() {
  try {
    const raw = fs.readFileSync(VAULT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...emptyVault(), ...parsed, version: 1 };
  } catch {
    return emptyVault();
  }
}

function writeVault(vault) {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  const next = { ...emptyVault(), ...vault, version: 1 };
  const tmp = `${VAULT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, VAULT_PATH);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 50 * 1024 * 1024) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

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
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname === '/api/vault' && req.method === 'GET') {
      sendJson(res, 200, readVault());
      return;
    }
    if (url.pathname === '/api/vault' && req.method === 'PUT') {
      writeVault(await readJsonBody(req));
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/token' && req.method === 'GET') {
      sendJson(res, 200, { token: readVault().lichessToken ?? null });
      return;
    }
    if (url.pathname === '/api/token' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const vault = readVault();
      vault.lichessToken = typeof body.token === 'string' && body.token ? body.token : null;
      writeVault(vault);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
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
