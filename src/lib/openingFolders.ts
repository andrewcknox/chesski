import type { Edge, NormFen, Repertoire } from '../types';
import { applyMove, STARTING_FEN_NORM } from './chess';
import { CURATED_OPENINGS, type CuratedOpening } from './openings';

export interface OpeningFolder {
  key: string;
  name: string;
  color: Repertoire['color'];
  baseFen: NormFen;
  path: Edge[];
}

export function listOpeningFoldersForRepertoire(rep: Pick<Repertoire, 'color' | 'rootFen'>, edges: Edge[]): OpeningFolder[] {
  return CURATED_OPENINGS
    .filter(opening => opening.color === rep.color)
    .map(opening => {
      const path = findOpeningPathInRepertoire(rep, opening, edges);
      if (!path) return null;
      const baseFen = openingBaseFen(opening);
      if (!baseFen) return null;
      return {
        key: opening.key,
        name: opening.name,
        color: opening.color,
        baseFen,
        path,
      };
    })
    .filter((folder): folder is OpeningFolder => !!folder);
}

export function findOpeningPathInRepertoire(
  rep: Pick<Repertoire, 'color' | 'rootFen'>,
  opening: Pick<CuratedOpening, 'color' | 'moves'>,
  edges: Edge[]
): Edge[] | null {
  if (rep.color !== opening.color) return null;

  const byParent = new Map<NormFen, Edge[]>();
  for (const edge of edges) {
    const current = byParent.get(edge.parentFen) ?? [];
    current.push(edge);
    byParent.set(edge.parentFen, current);
  }

  let cursorFen: NormFen = STARTING_FEN_NORM;
  let reachedRoot = rep.rootFen === STARTING_FEN_NORM;
  const path: Edge[] = [];
  for (const move of opening.moves) {
    const result = applyMove(cursorFen, move);
    if (!result) return null;

    if (reachedRoot) {
      const stored = byParent.get(cursorFen)?.find(edge => edge.uci === result.uci && edge.childFen === result.fen);
      if (!stored) return null;
      path.push(stored);
    }

    cursorFen = result.fen;
    if (!reachedRoot && cursorFen === rep.rootFen) reachedRoot = true;
  }

  return reachedRoot ? path : null;
}

export function openingBaseFen(opening: Pick<CuratedOpening, 'moves'>): NormFen | null {
  let cursorFen: NormFen = STARTING_FEN_NORM;
  for (const move of opening.moves) {
    const result = applyMove(cursorFen, move);
    if (!result) return null;
    cursorFen = result.fen;
  }
  return cursorFen;
}
