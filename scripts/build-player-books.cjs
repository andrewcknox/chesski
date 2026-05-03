const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');

const ROOT = path.resolve(__dirname, '..');
const MAX_OPENING_PLIES = 24;

const PLAYERS = [
  { key: 'morphy', name: 'Paul Morphy', pgn: 'public/players/MorphyRaw/Morphy.pgn', match: /morphy,\s*paul/i },
  { key: 'fischer', name: 'Bobby Fischer', pgn: 'public/players/FischerRaw/Fischer.pgn', match: /fischer,\s*(robert|bobby)|fischer,\s*r/i },
  { key: 'kasparov', name: 'Garry Kasparov', pgn: 'public/players/KasparovRaw/Kasparov.pgn', match: /kasparov,\s*garry|kasparov,\s*g/i },
  { key: 'carlsen', name: 'Magnus Carlsen', pgn: 'public/players/CarlsenRaw/Carlsen.pgn', match: /carlsen,\s*magnus|carlsen,\s*m/i },
  { key: 'anderssen', name: 'Adolf Anderssen', pgn: 'public/players/AnderssenRaw/Anderssen.pgn', match: /anderssen,\s*adolf/i },
  { key: 'capablanca', name: 'Jose Raul Capablanca', pgn: 'public/players/CapablancaRaw/Capablanca.pgn', match: /capablanca,\s*jose\s*raul|capablanca,\s*j/i },
  { key: 'tal', name: 'Mikhail Tal', pgn: 'public/players/TalRaw/Tal.pgn', match: /tal,\s*mihail|tal,\s*mikhail|tal,\s*m/i },
  { key: 'botvinnik', name: 'Mikhail Botvinnik', pgn: 'public/players/BotvinnikRaw/Botvinnik.pgn', match: /botvinnik,\s*mikhail|botvinnik,\s*m/i },
  { key: 'caruana', name: 'Fabiano Caruana', pgn: 'public/players/CaruanaRaw/Caruana.pgn', match: /caruana,\s*fabiano|caruana,\s*f/i },
];

function normalizeFen(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

function resultForColor(result, color) {
  if (result === '1/2-1/2') return 'draws';
  if (color === 'w') return result === '1-0' ? 'wins' : result === '0-1' ? 'losses' : null;
  return result === '0-1' ? 'wins' : result === '1-0' ? 'losses' : null;
}

function splitGames(pgn) {
  return pgn.split(/\r?\n(?=\[Event )/).map(g => g.trim()).filter(Boolean);
}

function gameLabel(headers) {
  const white = String(headers.White || 'White').trim();
  const black = String(headers.Black || 'Black').trim();
  const event = String(headers.Event || '').trim();
  const site = String(headers.Site || '').trim();
  const date = String(headers.Date || '').trim();
  const result = String(headers.Result || '').trim();
  const place = [event, site].filter(Boolean).join(', ');
  const suffix = [place, date].filter(Boolean).join(' - ');
  return `${white} vs ${black}${result ? ` ${result}` : ''}${suffix ? ` (${suffix})` : ''}`;
}

function candidateGames(candidate) {
  return candidate.wins + candidate.draws + candidate.losses;
}

function resultScoreRate(candidate) {
  const n = candidateGames(candidate);
  if (n <= 0) return 0;
  return (candidate.wins + candidate.draws * 0.5) / n;
}

function isCandidateTakeable(candidate) {
  return candidate.wins > candidate.losses;
}

function compareCandidates(a, b) {
  const netDelta = (b.wins - b.losses) - (a.wins - a.losses);
  if (netDelta !== 0) return netDelta;
  const scoreDelta = resultScoreRate(b) - resultScoreRate(a);
  if (scoreDelta !== 0) return scoreDelta;
  if (b.wins !== a.wins) return b.wins - a.wins;
  const gamesDelta = candidateGames(b) - candidateGames(a);
  if (gamesDelta !== 0) return gamesDelta;
  return b.draws - a.draws;
}

function makeBook(player) {
  const pgn = fs.readFileSync(path.join(ROOT, player.pgn), 'utf8');
  const games = splitGames(pgn);
  const positions = new Map();
  let parsed = 0;
  let indexedGames = 0;

  for (const game of games) {
    const chess = new Chess();
    try {
      chess.loadPgn(game, { strict: false });
    } catch {
      continue;
    }
    parsed++;
    const headers = chess.header();
    const white = String(headers.White || '');
    const black = String(headers.Black || '');
    const result = String(headers.Result || '');
    const label = gameLabel(headers);
    const color = player.match.test(white) ? 'w' : player.match.test(black) ? 'b' : null;
    if (!color) continue;
    const bucket = resultForColor(result, color);
    if (!bucket) continue;
    indexedGames++;

    const moves = chess.history({ verbose: true }).slice(0, MAX_OPENING_PLIES);
    for (const move of moves) {
      if (move.color !== color) continue;
      const fen = normalizeFen(move.before);
      const key = `${color}::${fen}`;
      let byMove = positions.get(key);
      if (!byMove) {
        byMove = new Map();
        positions.set(key, byMove);
      }
      let stats = byMove.get(move.lan);
      if (!stats) {
        stats = { san: move.san, uci: move.lan, wins: 0, draws: 0, losses: 0, winExamples: [], drawExamples: [], lossExamples: [] };
        byMove.set(move.lan, stats);
      }
      stats[bucket]++;
      const exampleKey = bucket === 'wins' ? 'winExamples' : bucket === 'draws' ? 'drawExamples' : 'lossExamples';
      if (stats[exampleKey].length < 3 && !stats[exampleKey].includes(label)) stats[exampleKey].push(label);
    }
  }

  const compactPositions = [];
  for (const [key, byMove] of positions) {
    const moves = Array.from(byMove.values())
      .filter(isCandidateTakeable)
      .sort(compareCandidates)
      .map(m => ({ ...m, scoreRate: resultScoreRate(m) }));
    if (moves.length > 0) compactPositions.push([key, moves]);
  }

  return {
    key: player.key,
    name: player.name,
    sourcePgn: player.pgn,
    maxOpeningPlies: MAX_OPENING_PLIES,
    games: games.length,
    parsedGames: parsed,
    indexedGames,
    positions: compactPositions.length,
    entries: compactPositions,
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  maxOpeningPlies: MAX_OPENING_PLIES,
  players: PLAYERS.map(makeBook),
};

const outPath = path.join(ROOT, 'public/players/player-books.json');
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${outPath}`);
for (const player of out.players) {
  console.log(`${player.name}: ${player.indexedGames} indexed games, ${player.positions} positive positions`);
}
