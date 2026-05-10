const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');

const ROOT = path.resolve(__dirname, '..');
const MAX_OPENING_PLIES = 24;
const MAX_GAMES_PER_PLAYER = 600;

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
  { key: 'nimzowitsch', name: 'Aron Nimzowitsch', pgn: 'public/players/NimzowitschRaw/Nimzowitsch.pgn', match: /nimzowitsch/i },
  { key: 'reti', name: 'Richard Reti', pgn: 'public/players/RetiRaw/Reti.pgn', match: /r[eé]ti,\s*richard|reti,\s*r/i },
  { key: 'alekhine', name: 'Alexander Alekhine', pgn: 'public/players/AlekhineRaw/Alekhine.pgn', match: /alekhine/i },
  { key: 'breyer', name: 'Gyula Breyer', pgn: 'public/players/BreyerRaw/Breyer.pgn', match: /breyer/i },
  { key: 'bogoljubow', name: 'Efim Bogoljubow', pgn: 'public/players/BogoljubowRaw/Bogoljubow.pgn', match: /bogoljubow|bogolyubov/i },
  { key: 'larsen', name: 'Bent Larsen', pgn: 'public/players/LarsenRaw/Larsen.pgn', match: /larsen,\s*bent|larsen,\s*b/i },
  { key: 'petrosian', name: 'Tigran Petrosian', pgn: 'public/players/PetrosianRaw/Petrosian.pgn', match: /petrosian,\s*tigran|petrosian,\s*t/i },
  { key: 'bronstein', name: 'David Bronstein', pgn: 'public/players/BronsteinRaw/Bronstein.pgn', match: /bronstein,\s*david|bronstein,\s*d/i },
  { key: 'blackburne', name: 'Joseph Blackburne', pgn: 'public/players/BlackburneRaw/Blackburne.pgn', match: /blackburne/i },
  { key: 'bird', name: 'Henry Bird', pgn: 'public/players/BirdRaw/Bird.pgn', match: /bird,\s*henry|bird,\s*h/i },
  { key: 'chigorin', name: 'Mikhail Chigorin', pgn: 'public/players/ChigorinRaw/Chigorin.pgn', match: /chigorin/i },
  { key: 'delabourdonnais', name: 'Louis de La Bourdonnais', pgn: 'public/players/DeLaBourdonnaisRaw/DeLaBourdonnais.pgn', match: /bourdonnais/i },
  { key: 'mcdonnell', name: 'Alexander McDonnell', pgn: 'public/players/McDonnellRaw/McDonnell.pgn', match: /mcdonnell/i },
  { key: 'staunton', name: 'Howard Staunton', pgn: 'public/players/StauntonRaw/Staunton.pgn', match: /staunton/i },
  { key: 'steinitz', name: 'William Steinitz', pgn: 'public/players/SteinitzRaw/Steinitz.pgn', match: /steinitz/i },
  { key: 'zukertort', name: 'Johannes Zukertort', pgn: 'public/players/ZukertortRaw/Zukertort.pgn', match: /zukertort/i },
  { key: 'spielmann', name: 'Rudolf Spielmann', pgn: 'public/players/SpielmannRaw/Spielmann.pgn', match: /spielmann/i },
  { key: 'benko', name: 'Pal Benko', pgn: 'public/players/BenkoRaw/Benko.pgn', match: /benko/i },
  { key: 'smyslov', name: 'Vasily Smyslov', pgn: 'public/players/SmyslovRaw/Smyslov.pgn', match: /smyslov/i },
  { key: 'spassky', name: 'Boris Spassky', pgn: 'public/players/SpasskyRaw/Spassky.pgn', match: /spassky/i },
  { key: 'keres', name: 'Paul Keres', pgn: 'public/players/KeresRaw/Keres.pgn', match: /keres/i },
  { key: 'korchnoi', name: 'Viktor Korchnoi', pgn: 'public/players/KorchnoiRaw/Korchnoi.pgn', match: /korchnoi|kortchnoi/i },
  { key: 'giri', name: 'Anish Giri', pgn: 'public/players/GiriRaw/Giri.pgn', match: /giri,\s*anish|giri,\s*a/i },
  { key: 'aronian', name: 'Levon Aronian', pgn: 'public/players/AronianRaw/Aronian.pgn', match: /aronian/i },
  { key: 'mamedyarov', name: 'Shakhriyar Mamedyarov', pgn: 'public/players/MamedyarovRaw/Mamedyarov.pgn', match: /mamedyarov/i },
  { key: 'firouzja', name: 'Alireza Firouzja', pgn: 'public/players/FirouzjaRaw/Firouzja.pgn', match: /firouzja/i },
  { key: 'nakamura', name: 'Hikaru Nakamura', pgn: 'public/players/NakamuraRaw/Nakamura.pgn', match: /nakamura/i },
  { key: 'vachierlagrave', name: 'Maxime Vachier-Lagrave', pgn: 'public/players/VachierLagraveRaw/VachierLagrave.pgn', match: /vachier.?lagrave/i },
  { key: 'duda', name: 'Jan-Krzysztof Duda', pgn: 'public/players/DudaRaw/Duda.pgn', match: /duda/i },
  { key: 'rapport', name: 'Richard Rapport', pgn: 'public/players/RapportRaw/Rapport.pgn', match: /rapport/i },
  { key: 'so', name: 'Wesley So', pgn: 'public/players/SoRaw/So.pgn', match: /so,\s*wesley|so,\s*w/i },
  { key: 'gukesh', name: 'Dommaraju Gukesh', pgn: 'public/players/GukeshRaw/Gukesh.pgn', match: /gukesh/i },
  { key: 'praggnanandhaa', name: 'Rameshbabu Praggnanandhaa', pgn: 'public/players/PraggnanandhaaRaw/Praggnanandhaa.pgn', match: /praggnanandhaa/i },
  { key: 'erigaisi', name: 'Arjun Erigaisi', pgn: 'public/players/ErigaisiRaw/Erigaisi.pgn', match: /erigaisi/i },
  { key: 'abdusattorov', name: 'Nodirbek Abdusattorov', pgn: 'public/players/AbdusattorovRaw/Abdusattorov.pgn', match: /abdusattorov/i },
  { key: 'keymer', name: 'Vincent Keymer', pgn: 'public/players/KeymerRaw/Keymer.pgn', match: /keymer/i },
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

function sourceLineFromMoves(label, moves, startIndex) {
  return {
    label,
    moves: moves.slice(startIndex, startIndex + 10).map(move => ({
      san: move.san,
      uci: move.lan,
      color: move.color,
    })),
  };
}

function bucketRank(bucket) {
  if (bucket === 'wins') return 3;
  if (bucket === 'draws') return 2;
  return 1;
}

function makeBook(player) {
  const pgn = fs.readFileSync(path.join(ROOT, player.pgn), 'utf8');
  const allGames = splitGames(pgn);
  const games = allGames.slice(-MAX_GAMES_PER_PLAYER);
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
    for (const [idx, move] of moves.entries()) {
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
      if (!stats.sourceLine || bucketRank(bucket) > (stats.sourceLineRank ?? 0)) {
        stats.sourceLine = sourceLineFromMoves(label, moves, idx);
        stats.sourceLineRank = bucketRank(bucket);
      }
    }
  }

  const compactPositions = [];
  for (const [key, byMove] of positions) {
    const moves = Array.from(byMove.values())
      .filter(isCandidateTakeable)
      .sort(compareCandidates)
      .map(({ sourceLineRank, ...m }) => ({ ...m, scoreRate: resultScoreRate(m) }));
    if (moves.length > 0) compactPositions.push([key, moves]);
  }

  return {
    key: player.key,
    name: player.name,
    sourcePgn: player.pgn,
    maxOpeningPlies: MAX_OPENING_PLIES,
    games: allGames.length,
    sampledGames: games.length,
    parsedGames: parsed,
    indexedGames,
    positions: compactPositions.length,
    entries: compactPositions,
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  maxOpeningPlies: MAX_OPENING_PLIES,
  maxGamesPerPlayer: MAX_GAMES_PER_PLAYER,
  players: PLAYERS.map(makeBook),
};

const outPath = path.join(ROOT, 'public/players/player-books.json');
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${outPath}`);
for (const player of out.players) {
  console.log(`${player.name}: ${player.indexedGames} indexed games, ${player.positions} positive positions`);
}
