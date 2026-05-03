// One-off build script: read Lichess ECO TSVs, convert to { normFen: { eco, name } }.
// Run once: `node scripts/build-eco.mjs`. Output: src/data/eco.json
import { readFileSync, writeFileSync } from 'node:fs';
import { Chess } from '../node_modules/chess.js/dist/esm/chess.js';

const TSV_FILES = ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv'].map(f => `scripts/eco-tsv/${f}`);

function normalizeFen(fen) {
  const parts = fen.split(' ');
  return parts.length < 4 ? fen : parts.slice(0, 4).join(' ');
}

const out = {};
let totalRows = 0;
let processed = 0;

for (const file of TSV_FILES) {
  const content = readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    totalRows++;
    const [eco, name, pgn] = line.split('\t');
    if (!eco || !name || !pgn) continue;
    const chess = new Chess();
    try {
      chess.loadPgn(pgn);
    } catch (e) {
      continue;
    }
    const norm = normalizeFen(chess.fen());
    // If duplicate, prefer the LONGER name (more specific)
    const existing = out[norm];
    if (!existing || name.length > existing.name.length) {
      out[norm] = { eco, name };
    }
    processed++;
  }
}

writeFileSync('src/data/eco.json', JSON.stringify(out));
console.log(`Wrote ${Object.keys(out).length} unique positions (from ${processed}/${totalRows} rows)`);
