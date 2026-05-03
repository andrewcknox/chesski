const fs = require('fs');
const path = require('path');
const os = require('os');

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

async function handleVaultApi(req, res, baseUrl) {
  const url = new URL(req.url || '/', baseUrl);
  if (url.pathname === '/api/vault' && req.method === 'GET') {
    sendJson(res, 200, readVault());
    return true;
  }
  if (url.pathname === '/api/vault' && req.method === 'PUT') {
    writeVault(await readJsonBody(req));
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/token' && req.method === 'GET') {
    sendJson(res, 200, { token: readVault().lichessToken ?? null });
    return true;
  }
  if (url.pathname === '/api/token' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const vault = readVault();
    vault.lichessToken = typeof body.token === 'string' && body.token ? body.token : null;
    writeVault(vault);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/vault-status' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, path: VAULT_PATH });
    return true;
  }
  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }
  return false;
}

module.exports = {
  VAULT_PATH,
  readVault,
  writeVault,
  sendJson,
  readJsonBody,
  handleVaultApi,
};
