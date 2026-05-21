import type { Color, NormFen, Repertoire } from '../types';
import { applyMove, computeOpeningFen, STARTING_FEN_NORM } from './chess';
import type { OpeningLine, ResolvedOpeningLine } from './openings';

export interface PreparedOpeningLine {
  moves: string[];
  scaffoldPlyCount: number;
}

export function openingRootFen(opening: Pick<OpeningLine, 'moves' | 'name'>): NormFen {
  try {
    return computeOpeningFen(opening.moves);
  } catch {
    throw new Error(`${opening.name} has an invalid curated move sequence.`);
  }
}

export function prepareOpeningLineForRepertoire(
  rep: Pick<Repertoire, 'name' | 'color' | 'rootFen'>,
  opening: Pick<ResolvedOpeningLine, 'name' | 'color' | 'moves'>,
  line: string[]
): PreparedOpeningLine {
  // TODO: make this transposition-aware for openings like the Catalan that
  // can share structures across multiple common move orders.
  validateOpeningColor(rep.color, opening);
  const openingFen = openingRootFen(opening);
  let cursorFen: NormFen = STARTING_FEN_NORM;
  let rootPly: number | null = rep.rootFen === STARTING_FEN_NORM ? 0 : null;

  if (line.length < opening.moves.length) {
    throw new Error(`${opening.name} line is shorter than its selected opening root.`);
  }

  for (const [idx, move] of line.entries()) {
    const result = applyMove(cursorFen, move);
    if (!result) throw new Error(`${opening.name} line cannot play ${move} from its position at ply ${idx + 1}.`);
    cursorFen = result.fen;
    const ply = idx + 1;
    if (ply === opening.moves.length && cursorFen !== openingFen) {
      throw new Error(`${opening.name} line does not reach the selected opening root.`);
    }
    if (rootPly === null && cursorFen === rep.rootFen) {
      rootPly = ply;
    }
  }

  if (rootPly === null) {
    throw new Error(`${opening.name} cannot legally connect to ${rep.name}'s repertoire root.`);
  }

  return {
    moves: line.slice(rootPly),
    scaffoldPlyCount: Math.max(0, opening.moves.length - rootPly),
  };
}

export function validateOpeningColor(color: Color, opening: Pick<ResolvedOpeningLine, 'name' | 'color'>): void {
  if (color !== opening.color) {
    throw new Error(`${opening.name} is a ${opening.color === 'w' ? 'White' : 'Black'} opening. Add it to a ${opening.color === 'w' ? 'White' : 'Black'} repertoire.`);
  }
}
