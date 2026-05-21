import { Chess } from 'chess.js';

function fenAfter(moves) {
  const chess = new Chess();
  for (const move of moves) chess.move(move);
  return chess.fen().split(' ').slice(0, 4).join(' ');
}

function assertLineMatchesOpening(openingName, openingMoves, lineMoves) {
  const openingFen = fenAfter(openingMoves);
  const candidateFen = fenAfter(lineMoves.slice(0, openingMoves.length));
  if (candidateFen !== openingFen) {
    throw new Error(`${openingName} scoped generation accepted the wrong base path.\nexpected=${openingMoves.join(' ')}\nactual=${lineMoves.slice(0, openingMoves.length).join(' ')}`);
  }
}

const italian = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'];
const ruyLopez = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'];
const queensGambit = ['d4', 'd5', 'c4'];

assertLineMatchesOpening('Italian Game', italian, [...italian, 'Nf6']);
assertLineMatchesOpening("Queen's Gambit", queensGambit, [...queensGambit, 'e6']);

let rejectedRuyAsItalian = false;
try {
  assertLineMatchesOpening('Italian Game', italian, [...ruyLopez, 'a6']);
} catch {
  rejectedRuyAsItalian = true;
}

if (!rejectedRuyAsItalian) {
  throw new Error('Italian Game scoped generation did not reject a Ruy Lopez line.');
}

console.log('opening-scope regression passed');
