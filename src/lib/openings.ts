import type { Color } from '../types';

export interface CuratedOpening {
  key: string;
  name: string;
  color: Color;
  // SAN moves from the absolute starting position to the signature position.
  // These get pre-loaded as edges in the new repertoire.
  moves: string[];
}

export const CURATED_OPENINGS: CuratedOpening[] = [
  {
    key: 'evans-w',
    name: 'Evans Gambit',
    color: 'w',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4'],
  },
  {
    key: 'exchange-ck-w',
    name: 'Exchange Caro-Kann',
    color: 'w',
    moves: ['e4', 'c6', 'd4', 'd5', 'exd5', 'cxd5'],
  },
  {
    key: 'exchange-ck-b',
    name: 'Exchange Caro-Kann',
    color: 'b',
    moves: ['e4', 'c6', 'd4', 'd5', 'exd5', 'cxd5'],
  },
  {
    key: 'qgd-b',
    name: "Queen's Gambit Declined",
    color: 'b',
    moves: ['d4', 'd5', 'c4', 'e6'],
  },
];

export function findOpening(key: string): CuratedOpening | undefined {
  return CURATED_OPENINGS.find(o => o.key === key);
}
