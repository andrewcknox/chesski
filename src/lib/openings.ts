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
    key: 'italian-w',
    name: 'Italian Game',
    color: 'w',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'],
  },
  {
    key: 'giuoco-piano-w',
    name: 'Giuoco Piano',
    color: 'w',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4'],
  },
  {
    key: 'evans-w',
    name: 'Evans Gambit',
    color: 'w',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4'],
  },
  {
    key: 'two-knights-w',
    name: 'Two Knights Italian',
    color: 'w',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5'],
  },
  {
    key: 'ruy-lopez-w',
    name: 'Ruy Lopez',
    color: 'w',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'],
  },
  {
    key: 'ruy-lopez-berlin-w',
    name: 'Ruy Lopez: Berlin',
    color: 'w',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6', 'O-O'],
  },
  {
    key: 'ruy-lopez-morphy-w',
    name: 'Ruy Lopez: Morphy Defense',
    color: 'w',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7'],
  },
  {
    key: 'scotch-w',
    name: 'Scotch Game',
    color: 'w',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'd4'],
  },
  {
    key: 'scotch-gambit-w',
    name: 'Scotch Gambit',
    color: 'w',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Bc4'],
  },
  {
    key: 'vienna-w',
    name: 'Vienna Game',
    color: 'w',
    moves: ['e4', 'e5', 'Nc3'],
  },
  {
    key: 'vienna-gambit-w',
    name: 'Vienna Gambit',
    color: 'w',
    moves: ['e4', 'e5', 'Nc3', 'Nf6', 'f4'],
  },
  {
    key: 'kings-gambit-w',
    name: "King's Gambit",
    color: 'w',
    moves: ['e4', 'e5', 'f4'],
  },
  {
    key: 'kings-gambit-accepted-w',
    name: "King's Gambit Accepted",
    color: 'w',
    moves: ['e4', 'e5', 'f4', 'exf4', 'Nf3', 'g5'],
  },
  {
    key: 'qg-w',
    name: "Queen's Gambit",
    color: 'w',
    moves: ['d4', 'd5', 'c4'],
  },
  {
    key: 'qga-w',
    name: "Queen's Gambit Accepted",
    color: 'w',
    moves: ['d4', 'd5', 'c4', 'dxc4', 'e4'],
  },
  {
    key: 'qgd-w',
    name: "Queen's Gambit Declined",
    color: 'w',
    moves: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5'],
  },
  {
    key: 'london-w',
    name: 'London System',
    color: 'w',
    moves: ['d4', 'd5', 'Bf4'],
  },
  {
    key: 'london-nf6-w',
    name: 'London System vs Nf6',
    color: 'w',
    moves: ['d4', 'Nf6', 'Bf4', 'd5', 'e3', 'e6', 'Nf3'],
  },
  {
    key: 'catalan-w',
    name: 'Catalan Opening',
    color: 'w',
    moves: ['d4', 'Nf6', 'c4', 'e6', 'g3'],
  },
  {
    key: 'open-catalan-w',
    name: 'Open Catalan',
    color: 'w',
    moves: ['d4', 'Nf6', 'c4', 'e6', 'g3', 'd5', 'Bg2', 'dxc4'],
  },
  {
    key: 'english-w',
    name: 'English Opening',
    color: 'w',
    moves: ['c4'],
  },
  {
    key: 'english-symmetrical-w',
    name: 'English: Symmetrical',
    color: 'w',
    moves: ['c4', 'c5', 'Nc3', 'Nc6', 'g3'],
  },
  {
    key: 'english-botvinnik-w',
    name: 'English: Botvinnik Setup',
    color: 'w',
    moves: ['c4', 'c5', 'Nc3', 'Nc6', 'g3', 'g6', 'Bg2', 'Bg7', 'e4'],
  },
  {
    key: 'reti-w',
    name: 'Reti Opening',
    color: 'w',
    moves: ['Nf3'],
  },
  {
    key: 'reti-kia-w',
    name: "Reti: King's Indian Attack",
    color: 'w',
    moves: ['Nf3', 'd5', 'g3', 'Nf6', 'Bg2', 'e6', 'O-O'],
  },
  {
    key: 'exchange-ck-w',
    name: 'Exchange Caro-Kann',
    color: 'w',
    moves: ['e4', 'c6', 'd4', 'd5', 'exd5', 'cxd5'],
  },
  {
    key: 'sicilian-b',
    name: 'Sicilian Defense',
    color: 'b',
    moves: ['e4', 'c5'],
  },
  {
    key: 'sicilian-najdorf-b',
    name: 'Sicilian: Najdorf',
    color: 'b',
    moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'],
  },
  {
    key: 'sicilian-dragon-b',
    name: 'Sicilian: Dragon',
    color: 'b',
    moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'g6'],
  },
  {
    key: 'sicilian-sveshnikov-b',
    name: 'Sicilian: Sveshnikov',
    color: 'b',
    moves: ['e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'e5'],
  },
  {
    key: 'sicilian-kan-b',
    name: 'Sicilian: Kan',
    color: 'b',
    moves: ['e4', 'c5', 'Nf3', 'e6', 'd4', 'cxd4', 'Nxd4', 'a6'],
  },
  {
    key: 'french-b',
    name: 'French Defense',
    color: 'b',
    moves: ['e4', 'e6'],
  },
  {
    key: 'french-advance-b',
    name: 'French: Advance',
    color: 'b',
    moves: ['e4', 'e6', 'd4', 'd5', 'e5'],
  },
  {
    key: 'french-winawer-b',
    name: 'French: Winawer',
    color: 'b',
    moves: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Bb4'],
  },
  {
    key: 'caro-kann-b',
    name: 'Caro-Kann Defense',
    color: 'b',
    moves: ['e4', 'c6'],
  },
  {
    key: 'exchange-ck-b',
    name: 'Exchange Caro-Kann',
    color: 'b',
    moves: ['e4', 'c6', 'd4', 'd5', 'exd5', 'cxd5'],
  },
  {
    key: 'caro-advance-b',
    name: 'Caro-Kann: Advance',
    color: 'b',
    moves: ['e4', 'c6', 'd4', 'd5', 'e5', 'Bf5'],
  },
  {
    key: 'caro-classical-b',
    name: 'Caro-Kann: Classical',
    color: 'b',
    moves: ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5'],
  },
  {
    key: 'scandinavian-b',
    name: 'Scandinavian Defense',
    color: 'b',
    moves: ['e4', 'd5'],
  },
  {
    key: 'scandinavian-main-b',
    name: 'Scandinavian: Main Line',
    color: 'b',
    moves: ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5'],
  },
  {
    key: 'pirc-b',
    name: 'Pirc Defense',
    color: 'b',
    moves: ['e4', 'd6', 'd4', 'Nf6', 'Nc3', 'g6'],
  },
  {
    key: 'modern-b',
    name: 'Modern Defense',
    color: 'b',
    moves: ['e4', 'g6', 'd4', 'Bg7', 'Nc3', 'd6'],
  },
  {
    key: 'alekhine-b',
    name: 'Alekhine Defense',
    color: 'b',
    moves: ['e4', 'Nf6'],
  },
  {
    key: 'alekhine-main-b',
    name: 'Alekhine: Main Line',
    color: 'b',
    moves: ['e4', 'Nf6', 'e5', 'Nd5', 'd4', 'd6', 'c4', 'Nb6'],
  },
  {
    key: 'dutch-b',
    name: 'Dutch Defense',
    color: 'b',
    moves: ['d4', 'f5'],
  },
  {
    key: 'dutch-leningrad-b',
    name: 'Dutch: Leningrad',
    color: 'b',
    moves: ['d4', 'f5', 'g3', 'Nf6', 'Bg2', 'g6'],
  },
  {
    key: 'dutch-stonewall-b',
    name: 'Dutch: Stonewall',
    color: 'b',
    moves: ['d4', 'f5', 'g3', 'Nf6', 'Bg2', 'e6', 'Nf3', 'd5'],
  },
  {
    key: 'slav-b',
    name: 'Slav Defense',
    color: 'b',
    moves: ['d4', 'd5', 'c4', 'c6'],
  },
  {
    key: 'slav-main-b',
    name: 'Slav: Main Line',
    color: 'b',
    moves: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'dxc4'],
  },
  {
    key: 'semi-slav-b',
    name: 'Semi-Slav Defense',
    color: 'b',
    moves: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'e6'],
  },
  {
    key: 'qgd-b',
    name: "Queen's Gambit Declined",
    color: 'b',
    moves: ['d4', 'd5', 'c4', 'e6'],
  },
  {
    key: 'qga-b',
    name: "Queen's Gambit Accepted",
    color: 'b',
    moves: ['d4', 'd5', 'c4', 'dxc4'],
  },
  {
    key: 'queens-indian-b',
    name: "Queen's Indian Defense",
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6'],
  },
  {
    key: 'nimzo-indian-b',
    name: 'Nimzo-Indian Defense',
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'],
  },
  {
    key: 'kings-indian-b',
    name: "King's Indian Defense",
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6'],
  },
  {
    key: 'kid-classical-b',
    name: "King's Indian: Classical",
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'Nf3', 'O-O', 'Be2', 'e5'],
  },
  {
    key: 'benoni-b',
    name: 'Benoni Defense',
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'e6'],
  },
  {
    key: 'modern-benoni-b',
    name: 'Modern Benoni',
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'e6', 'Nc3', 'exd5', 'cxd5', 'd6', 'e4', 'g6'],
  },
  {
    key: 'benko-b',
    name: 'Benko Gambit',
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'b5'],
  },
  {
    key: 'benko-accepted-b',
    name: 'Benko Gambit Accepted',
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'b5', 'cxb5', 'a6'],
  },
  {
    key: 'grunfeld-b',
    name: 'Grunfeld Defense',
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5'],
  },
  {
    key: 'grunfeld-exchange-b',
    name: 'Grunfeld: Exchange',
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5', 'cxd5', 'Nxd5', 'e4', 'Nxc3', 'bxc3', 'Bg7'],
  },
];

export function findOpening(key: string): CuratedOpening | undefined {
  return CURATED_OPENINGS.find(o => o.key === key);
}
