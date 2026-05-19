const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STOCKFISH_EXE = path.join(
  ROOT,
  'stockfish',
  'stockfish-12-windows-x86-64-avx2',
  'stockfish-12-windows-x86-64-avx2.exe'
);

let queue = Promise.resolve();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function denormalizeFen(fen) {
  const parts = String(fen || '').trim().split(/\s+/);
  if (parts.length >= 6) return parts.slice(0, 6).join(' ');
  if (parts.length >= 4) return [...parts.slice(0, 4), '0', '1'].join(' ');
  throw new Error('Invalid FEN.');
}

function parseInfoLine(line) {
  const multipv = Number(line.match(/\bmultipv\s+(\d+)/)?.[1] ?? '1');
  const cpMatch = line.match(/\bscore\s+cp\s+(-?\d+)/);
  const mateMatch = line.match(/\bscore\s+mate\s+(-?\d+)/);
  // UCI_ShowWDL output: `wdl <win> <draw> <loss>`, per-mille values summing to 1000,
  // reported from the side-to-move's perspective. Stockfish 12 emits this when the
  // `UCI_ShowWDL` option is enabled (set after `uciok` below).
  const wdlMatch = line.match(/\bwdl\s+(\d+)\s+(\d+)\s+(\d+)/);
  const pvMatch = line.match(/\bpv\s+(.+)$/);
  if (!pvMatch) return null;
  const out = { multipv, moves: pvMatch[1].trim() };
  if (cpMatch) out.cp = Number(cpMatch[1]);
  if (mateMatch) out.mate = Number(mateMatch[1]);
  if (wdlMatch) out.wdl = { win: Number(wdlMatch[1]), draw: Number(wdlMatch[2]), loss: Number(wdlMatch[3]) };
  return out;
}

function runStockfishEval(fen, multiPv = 5, depth = 18) {
  if (!fs.existsSync(STOCKFISH_EXE)) {
    throw new Error(`Stockfish not found at ${STOCKFISH_EXE}`);
  }

  const fullFen = denormalizeFen(fen);
  const requestedMultiPv = Math.max(1, Math.min(Number(multiPv) || 1, 8));
  const requestedDepth = Math.max(6, Math.min(Number(depth) || 18, 30));

  return new Promise((resolve, reject) => {
    const child = spawn(STOCKFISH_EXE, [], { cwd: path.dirname(STOCKFISH_EXE), windowsHide: true });
    const pvs = new Map();
    let stdout = '';
    let settled = false;

    // Per-eval cap is set vastly higher than depth-22 ever needs in practice (a
    // typical depth-22 eval finishes in seconds; pathological middlegame positions
    // might take a minute or two). The previous 45-second cap occasionally killed
    // legitimate depth-22 calls on cold positions, causing the caller to record a
    // null result that then poisoned downstream line generation. Slow generation
    // is fine; corrupt generation is not.
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('Stockfish timed out.'));
    }, 600000);

    function write(command) {
      child.stdin.write(`${command}\n`);
    }

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      let idx;
      while ((idx = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, idx).trim();
        stdout = stdout.slice(idx + 1);
        if (!line) continue;

        if (line === 'uciok') {
          write(`setoption name MultiPV value ${requestedMultiPv}`);
          // Enable WDL (Win/Draw/Loss) probability output. Stockfish 12+ supports
          // this. Used by the line-generation quality gate to judge moves by
          // expected-score drop rather than raw centipawn loss — which is more
          // honest for positions where cp swings don't correspond to practical
          // game-result swings (e.g. opening evals between roughly +0.7 and -0.3).
          write('setoption name UCI_ShowWDL value true');
          write('isready');
          continue;
        }
        if (line === 'readyok') {
          write(`position fen ${fullFen}`);
          write(`go depth ${requestedDepth}`);
          continue;
        }
        if (line.startsWith('info ')) {
          const parsed = parseInfoLine(line);
          if (parsed) pvs.set(parsed.multipv, parsed);
          continue;
        }
        if (line.startsWith('bestmove ')) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          write('quit');
          resolve({
            fen: fullFen,
            knodes: 0,
            depth: requestedDepth,
            pvs: Array.from(pvs.entries())
              .sort((a, b) => a[0] - b[0])
              .map(([, pv]) => {
                const { multipv, ...rest } = pv;
                void multipv;
                return rest;
              })
              .filter(pv => pv.moves),
          });
        }
      }
    });

    child.stderr.on('data', () => {});
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Stockfish exited before bestmove (${code}).`));
    });

    write('uci');
  });
}

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function handleStockfishApi(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/api/stockfish/eval') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return true;
  }
  try {
    const body = await readJson(req);
    const result = await enqueue(() => runStockfishEval(body.fen, body.multiPv, body.depth));
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

module.exports = { handleStockfishApi, runStockfishEval, STOCKFISH_EXE };
