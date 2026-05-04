import type { Color } from '../types';

export interface OpeningLine {
  key: string;
  name: string;
  // SAN moves from the absolute starting position to the signature position.
  moves: string[];
  continuations?: OpeningLine[];
}

export interface CuratedOpening extends OpeningLine {
  color: Color;
}

export type ResolvedOpeningLine = OpeningLine & { color: Color };

const BASE_CURATED_OPENINGS: CuratedOpening[] = [
  {
    key: 'italian-w',
    name: 'Italian Game',
    color: 'w',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'],
    continuations: [
      {
        key: 'giuoco-piano-w',
        name: 'Giuoco Piano',
        moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'],
        continuations: [
          {
            key: 'evans-w',
            name: 'Evans Gambit',
            moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4'],
          },
          {
            key: 'giuoco-piano-main-w',
            name: 'Giuoco Piano Main Line',
            moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4'],
          },
          {
            key: 'giuoco-pianissimo-w',
            name: 'Giuoco Pianissimo',
            moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd3', 'Nf6', 'c3'],
          },
        ],
      },
      {
        key: 'two-knights-w',
        name: 'Two Knights Game',
        moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6'],
        continuations: [
          {
            key: 'fried-liver-w',
            name: 'Fried Liver Attack',
            moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5', 'Nxd5'],
          },
          {
            key: 'two-knights-main-w',
            name: 'Two Knights Main Line',
            moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5', 'Na5'],
          },
          {
            key: 'modern-italian-w',
            name: 'Modern Italian',
            moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'd3', 'Bc5', 'c3'],
          },
        ],
      },
    ],
  },
  {
    key: 'ruy-lopez-w',
    name: 'Ruy Lopez',
    color: 'w',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'],
    continuations: [
      {
        key: 'ruy-lopez-berlin-w',
        name: 'Berlin Defense',
        moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6', 'O-O', 'Nxe4'],
      },
      {
        key: 'ruy-lopez-exchange-w',
        name: 'Exchange Variation',
        moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6', 'dxc6'],
      },
      {
        key: 'ruy-lopez-morphy-w',
        name: 'Morphy Defense',
        moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6'],
        continuations: [
          {
            key: 'ruy-lopez-closed-w',
            name: 'Closed Ruy Lopez',
            moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6'],
          },
          {
            key: 'ruy-lopez-open-w',
            name: 'Open Ruy Lopez',
            moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Nxe4'],
          },
        ],
      },
    ],
  },
  {
    key: 'scotch-w',
    name: 'Scotch Game',
    color: 'w',
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'd4'],
    continuations: [
      {
        key: 'scotch-main-w',
        name: 'Scotch Main Line',
        moves: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Nf6', 'Nc3'],
      },
      {
        key: 'scotch-classical-w',
        name: 'Scotch Classical',
        moves: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Bc5'],
      },
      {
        key: 'scotch-gambit-w',
        name: 'Scotch Gambit',
        moves: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Bc4'],
      },
    ],
  },
  {
    key: 'vienna-w',
    name: 'Vienna Game',
    color: 'w',
    moves: ['e4', 'e5', 'Nc3'],
    continuations: [
      {
        key: 'vienna-gambit-w',
        name: 'Vienna Gambit',
        moves: ['e4', 'e5', 'Nc3', 'Nf6', 'f4'],
      },
      {
        key: 'vienna-main-w',
        name: 'Vienna Main Line',
        moves: ['e4', 'e5', 'Nc3', 'Nf6', 'Bc4', 'Nc6', 'd3'],
      },
      {
        key: 'vienna-falkbeer-w',
        name: 'Vienna: Falkbeer Variation',
        moves: ['e4', 'e5', 'Nc3', 'Nf6', 'f4', 'd5'],
      },
    ],
  },
  {
    key: 'kings-gambit-w',
    name: "King's Gambit",
    color: 'w',
    moves: ['e4', 'e5', 'f4'],
    continuations: [
      {
        key: 'kings-gambit-accepted-w',
        name: "King's Gambit Accepted",
        moves: ['e4', 'e5', 'f4', 'exf4', 'Nf3', 'g5'],
      },
      {
        key: 'kings-gambit-declined-w',
        name: "King's Gambit Declined",
        moves: ['e4', 'e5', 'f4', 'Bc5', 'Nf3', 'd6'],
      },
      {
        key: 'kings-gambit-falkbeer-w',
        name: 'Falkbeer Countergambit',
        moves: ['e4', 'e5', 'f4', 'd5', 'exd5', 'e4'],
      },
    ],
  },
  {
    key: 'qg-w',
    name: "Queen's Gambit",
    color: 'w',
    moves: ['d4', 'd5', 'c4'],
    continuations: [
      {
        key: 'qgd-w',
        name: "Queen's Gambit Declined",
        moves: ['d4', 'd5', 'c4', 'e6'],
        continuations: [
          {
            key: 'qgd-main-w',
            name: 'QGD Main Line',
            moves: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3'],
          },
          {
            key: 'qgd-exchange-w',
            name: 'QGD Exchange Variation',
            moves: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'cxd5', 'exd5', 'Bg5'],
          },
        ],
      },
      {
        key: 'qga-w',
        name: "Queen's Gambit Accepted",
        moves: ['d4', 'd5', 'c4', 'dxc4', 'e4'],
      },
      {
        key: 'slav-vs-qg-w',
        name: 'Slav Defense',
        moves: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3'],
        continuations: [
          {
            key: 'slav-vs-qg-main-w',
            name: 'Slav Main Line',
            moves: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'dxc4'],
          },
          {
            key: 'slav-vs-qg-exchange-w',
            name: 'Exchange Slav',
            moves: ['d4', 'd5', 'c4', 'c6', 'cxd5', 'cxd5'],
          },
          {
            key: 'semi-slav-vs-qg-w',
            name: 'Semi-Slav Defense',
            moves: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'e6'],
          },
        ],
      },
    ],
  },
  {
    key: 'london-w',
    name: 'London System',
    color: 'w',
    moves: ['d4', 'd5', 'Bf4'],
    continuations: [
      {
        key: 'london-classical-w',
        name: 'Classical London',
        moves: ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6', 'Nf3'],
      },
      {
        key: 'london-qb6-w',
        name: 'London vs Qb6',
        moves: ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'c5', 'c3', 'Qb6'],
      },
      {
        key: 'london-c5-w',
        name: 'London vs Early c5',
        moves: ['d4', 'd5', 'Bf4', 'c5', 'e3', 'Nc6', 'Nf3'],
      },
    ],
  },
  {
    key: 'jobava-w',
    name: 'Jobava',
    color: 'w',
    moves: ['d4', 'Nf6', 'Nc3', 'd5', 'Bf4'],
    continuations: [
      {
        key: 'jobava-e6-w',
        name: 'Jobava vs e6',
        moves: ['d4', 'Nf6', 'Nc3', 'd5', 'Bf4', 'e6', 'e3', 'Bb4', 'Nge2'],
      },
      {
        key: 'jobava-c5-w',
        name: 'Jobava vs c5',
        moves: ['d4', 'Nf6', 'Nc3', 'd5', 'Bf4', 'c5', 'e3', 'Nc6', 'Nb5'],
      },
      {
        key: 'jobava-g6-w',
        name: 'Jobava vs g6',
        moves: ['d4', 'Nf6', 'Nc3', 'd5', 'Bf4', 'g6', 'e3', 'Bg7', 'h4'],
      },
    ],
  },
  {
    key: 'catalan-w',
    name: 'Catalan Opening',
    color: 'w',
    moves: ['d4', 'Nf6', 'c4', 'e6', 'g3'],
    continuations: [
      {
        key: 'open-catalan-w',
        name: 'Open Catalan',
        moves: ['d4', 'Nf6', 'c4', 'e6', 'g3', 'd5', 'Bg2', 'dxc4'],
      },
      {
        key: 'closed-catalan-w',
        name: 'Closed Catalan',
        moves: ['d4', 'Nf6', 'c4', 'e6', 'g3', 'd5', 'Bg2', 'Be7'],
      },
      {
        key: 'catalan-check-w',
        name: 'Catalan vs Bb4+',
        moves: ['d4', 'Nf6', 'c4', 'e6', 'g3', 'Bb4+', 'Bd2'],
      },
    ],
  },
  {
    key: 'english-w',
    name: 'English Opening',
    color: 'w',
    moves: ['c4'],
    continuations: [
      {
        key: 'english-symmetrical-w',
        name: 'Symmetrical English',
        moves: ['c4', 'c5', 'Nc3', 'Nc6', 'g3'],
      },
      {
        key: 'english-symmetrical-g3-w',
        name: 'Symmetrical English: g3',
        moves: ['c4', 'c5', 'g3', 'Nc6', 'Bg2', 'g6'],
      },
      {
        key: 'english-symmetrical-nf3-w',
        name: 'Symmetrical English: Nf3',
        moves: ['c4', 'c5', 'Nf3', 'Nf6', 'g3'],
      },
      {
        key: 'english-symmetrical-b3-w',
        name: 'Symmetrical English: b3',
        moves: ['c4', 'c5', 'b3', 'Nf6', 'Bb2'],
      },
      {
        key: 'english-reversed-sicilian-w',
        name: 'Reversed Sicilian',
        moves: ['c4', 'e5', 'Nc3', 'Nf6', 'g3'],
      },
      {
        key: 'english-indian-w',
        name: 'English vs Nf6',
        moves: ['c4', 'Nf6', 'Nc3', 'e6', 'Nf3'],
      },
      {
        key: 'english-kings-english-w',
        name: "King's English",
        moves: ['c4', 'g6', 'Nc3', 'Bg7', 'g3'],
      },
      {
        key: 'english-four-knights-w',
        name: 'English Four Knights',
        moves: ['c4', 'e5', 'Nc3', 'Nf6', 'Nf3', 'Nc6'],
      },
      {
        key: 'english-botvinnik-w',
        name: 'Botvinnik Setup',
        moves: ['c4', 'c5', 'Nc3', 'Nc6', 'g3', 'g6', 'Bg2', 'Bg7', 'e4'],
      },
    ],
  },
  {
    key: 'reti-w',
    name: 'Reti Opening',
    color: 'w',
    moves: ['Nf3'],
    continuations: [
      {
        key: 'reti-gambit-w',
        name: 'Reti Gambit vs d5',
        moves: ['Nf3', 'd5', 'c4', 'dxc4'],
      },
      {
        key: 'reti-kia-w',
        name: "King's Indian Attack",
        moves: ['Nf3', 'd5', 'g3', 'Nf6', 'Bg2', 'e6', 'O-O'],
      },
      {
        key: 'reti-english-w',
        name: 'Reti-English Setup',
        moves: ['Nf3', 'c5', 'c4', 'Nf6', 'g3'],
      },
      {
        key: 'reti-gambit-c5-w',
        name: 'Reti Gambit',
        moves: ['Nf3', 'c5', 'b4'],
      },
    ],
  },
  {
    key: 'sicilian-b',
    name: 'Sicilian Defense',
    color: 'b',
    moves: ['e4', 'c5'],
    continuations: [
      {
        key: 'open-sicilian-b',
        name: 'Open Sicilian',
        moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3'],
        continuations: [
          {
            key: 'sicilian-najdorf-b',
            name: 'Najdorf Variation',
            moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'],
          },
          {
            key: 'sicilian-dragon-b',
            name: 'Dragon Variation',
            moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'g6'],
          },
          {
            key: 'sicilian-classical-b',
            name: 'Classical Sicilian',
            moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'Nc6'],
          },
        ],
      },
      {
        key: 'sicilian-sveshnikov-b',
        name: 'Sveshnikov Variation',
        moves: ['e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'e5'],
      },
      {
        key: 'sicilian-alapin-b',
        name: 'Alapin Sicilian',
        moves: ['e4', 'c5', 'c3', 'd5'],
      },
    ],
  },
  {
    key: 'french-b',
    name: 'French Defense',
    color: 'b',
    moves: ['e4', 'e6'],
    continuations: [
      {
        key: 'french-advance-b',
        name: 'Advance Variation',
        moves: ['e4', 'e6', 'd4', 'd5', 'e5', 'c5'],
      },
      {
        key: 'french-exchange-b',
        name: 'Exchange Variation',
        moves: ['e4', 'e6', 'd4', 'd5', 'exd5', 'exd5'],
      },
      {
        key: 'french-winawer-b',
        name: 'Winawer Variation',
        moves: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Bb4'],
      },
      {
        key: 'french-classical-b',
        name: 'Classical Variation',
        moves: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Nf6'],
      },
    ],
  },
  {
    key: 'caro-kann-b',
    name: 'Caro-Kann Defense',
    color: 'b',
    moves: ['e4', 'c6'],
    continuations: [
      {
        key: 'caro-advance-b',
        name: 'Advance Variation',
        moves: ['e4', 'c6', 'd4', 'd5', 'e5', 'Bf5'],
      },
      {
        key: 'caro-classical-b',
        name: 'Classical Variation',
        moves: ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5'],
      },
      {
        key: 'exchange-ck-b',
        name: 'Exchange Variation',
        moves: ['e4', 'c6', 'd4', 'd5', 'exd5', 'cxd5'],
      },
      {
        key: 'caro-panov-b',
        name: 'Panov-Botvinnik Attack',
        moves: ['e4', 'c6', 'd4', 'd5', 'exd5', 'cxd5', 'c4', 'Nf6'],
      },
    ],
  },
  {
    key: 'scandinavian-b',
    name: 'Scandinavian Defense',
    color: 'b',
    moves: ['e4', 'd5'],
    continuations: [
      {
        key: 'scandinavian-main-b',
        name: 'Main Line',
        moves: ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5'],
      },
      {
        key: 'scandinavian-modern-b',
        name: 'Modern Scandinavian',
        moves: ['e4', 'd5', 'exd5', 'Nf6'],
      },
      {
        key: 'scandinavian-portuguese-b',
        name: 'Portuguese Gambit',
        moves: ['e4', 'd5', 'exd5', 'Nf6', 'd4', 'Bg4'],
      },
    ],
  },
  {
    key: 'pirc-b',
    name: 'Pirc Defense',
    color: 'b',
    moves: ['e4', 'd6', 'd4', 'Nf6', 'Nc3', 'g6'],
    continuations: [
      {
        key: 'pirc-austrian-b',
        name: 'Austrian Attack',
        moves: ['e4', 'd6', 'd4', 'Nf6', 'Nc3', 'g6', 'f4', 'Bg7'],
      },
      {
        key: 'pirc-classical-b',
        name: 'Classical System',
        moves: ['e4', 'd6', 'd4', 'Nf6', 'Nc3', 'g6', 'Nf3', 'Bg7', 'Be2', 'O-O'],
      },
      {
        key: 'pirc-150-b',
        name: '150 Attack',
        moves: ['e4', 'd6', 'd4', 'Nf6', 'Nc3', 'g6', 'Be3', 'Bg7', 'Qd2'],
      },
    ],
  },
  {
    key: 'modern-b',
    name: 'Modern Defense',
    color: 'b',
    moves: ['e4', 'g6', 'd4', 'Bg7', 'Nc3', 'd6'],
    continuations: [
      {
        key: 'modern-averbakh-b',
        name: 'Averbakh System',
        moves: ['e4', 'g6', 'd4', 'Bg7', 'Nc3', 'd6', 'Be3', 'a6'],
      },
      {
        key: 'modern-tiger-b',
        name: 'Tiger Modern Setup',
        moves: ['e4', 'g6', 'd4', 'Bg7', 'Nc3', 'd6', 'f4', 'a6'],
      },
      {
        key: 'modern-classical-b',
        name: 'Classical Modern',
        moves: ['e4', 'g6', 'd4', 'Bg7', 'Nc3', 'd6', 'Nf3', 'a6'],
      },
    ],
  },
  {
    key: 'alekhine-b',
    name: 'Alekhine Defense',
    color: 'b',
    moves: ['e4', 'Nf6'],
    continuations: [
      {
        key: 'alekhine-modern-b',
        name: 'Modern Variation',
        moves: ['e4', 'Nf6', 'e5', 'Nd5', 'd4', 'd6', 'Nf3'],
      },
      {
        key: 'alekhine-exchange-b',
        name: 'Exchange Variation',
        moves: ['e4', 'Nf6', 'e5', 'Nd5', 'd4', 'd6', 'c4', 'Nb6', 'exd6'],
      },
      {
        key: 'alekhine-four-pawns-b',
        name: 'Four Pawns Attack',
        moves: ['e4', 'Nf6', 'e5', 'Nd5', 'd4', 'd6', 'c4', 'Nb6', 'f4'],
      },
    ],
  },
  {
    key: 'dutch-b',
    name: 'Dutch Defense',
    color: 'b',
    moves: ['d4', 'f5'],
    continuations: [
      {
        key: 'dutch-leningrad-b',
        name: 'Leningrad Dutch',
        moves: ['d4', 'f5', 'g3', 'Nf6', 'Bg2', 'g6'],
      },
      {
        key: 'dutch-stonewall-b',
        name: 'Stonewall Dutch',
        moves: ['d4', 'f5', 'g3', 'Nf6', 'Bg2', 'e6', 'Nf3', 'd5'],
      },
      {
        key: 'dutch-classical-b',
        name: 'Classical Dutch',
        moves: ['d4', 'f5', 'c4', 'Nf6', 'g3', 'e6', 'Bg2', 'Be7'],
      },
    ],
  },
  {
    key: 'slav-b',
    name: 'Slav Defense',
    color: 'b',
    moves: ['d4', 'd5', 'c4', 'c6'],
    continuations: [
      {
        key: 'slav-main-b',
        name: 'Slav Main Line',
        moves: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'dxc4'],
      },
      {
        key: 'slav-exchange-b',
        name: 'Exchange Slav',
        moves: ['d4', 'd5', 'c4', 'c6', 'cxd5', 'cxd5'],
      },
      {
        key: 'semi-slav-b',
        name: 'Semi-Slav Defense',
        moves: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'e6'],
      },
    ],
  },
  {
    key: 'queens-indian-b',
    name: "Queen's Indian Defense",
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6'],
    continuations: [
      {
        key: 'queens-indian-classical-b',
        name: 'Classical Variation',
        moves: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6', 'g3', 'Ba6'],
      },
      {
        key: 'queens-indian-petrosian-b',
        name: 'Petrosian Variation',
        moves: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6', 'a3', 'Bb7'],
      },
    ],
  },
  {
    key: 'nimzo-indian-b',
    name: 'Nimzo-Indian Defense',
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'],
    continuations: [
      {
        key: 'nimzo-classical-b',
        name: 'Classical Variation',
        moves: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'Qc2', 'O-O'],
      },
      {
        key: 'nimzo-rubinstein-b',
        name: 'Rubinstein Variation',
        moves: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'O-O'],
      },
      {
        key: 'nimzo-samisch-b',
        name: 'Samisch Variation',
        moves: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'a3', 'Bxc3+'],
      },
    ],
  },
  {
    key: 'kings-indian-b',
    name: "King's Indian Defense",
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6'],
    continuations: [
      {
        key: 'kid-classical-b',
        name: 'Classical Variation',
        moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'Nf3', 'O-O', 'Be2', 'e5'],
      },
      {
        key: 'kid-samisch-b',
        name: 'Samisch Variation',
        moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'f3', 'O-O', 'Be3'],
      },
      {
        key: 'kid-four-pawns-b',
        name: 'Four Pawns Attack',
        moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'f4', 'O-O', 'Nf3', 'c5'],
      },
    ],
  },
  {
    key: 'benoni-b',
    name: 'Benoni Defense',
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'e6'],
    continuations: [
      {
        key: 'modern-benoni-b',
        name: 'Modern Benoni',
        moves: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'e6', 'Nc3', 'exd5', 'cxd5', 'd6', 'e4', 'g6'],
      },
      {
        key: 'benoni-fianchetto-b',
        name: 'Fianchetto Benoni',
        moves: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'e6', 'Nf3', 'exd5', 'cxd5', 'd6', 'g3', 'g6'],
      },
      {
        key: 'benko-accepted-b',
        name: 'Benko Gambit Accepted',
        moves: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'b5', 'cxb5', 'a6'],
      },
      {
        key: 'benko-declined-b',
        name: 'Benko Declined',
        moves: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'b5', 'Nf3'],
      },
    ],
  },
  {
    key: 'petrov-b',
    name: 'Petrov Defense',
    color: 'b',
    moves: ['e4', 'e5', 'Nf3', 'Nf6'],
    continuations: [
      {
        key: 'petrov-classical-b',
        name: 'Classical Petrov',
        moves: ['e4', 'e5', 'Nf3', 'Nf6', 'Nxe5', 'd6', 'Nf3', 'Nxe4'],
      },
      {
        key: 'petrov-three-knights-b',
        name: 'Three Knights Petrov',
        moves: ['e4', 'e5', 'Nf3', 'Nf6', 'Nc3', 'Nc6'],
      },
      {
        key: 'petrov-modern-b',
        name: 'Modern Attack',
        moves: ['e4', 'e5', 'Nf3', 'Nf6', 'Nxe5', 'd6', 'Nf3', 'Nxe4', 'd4', 'd5'],
      },
    ],
  },
  {
    key: 'grunfeld-b',
    name: 'Grunfeld Defense',
    color: 'b',
    moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5'],
    continuations: [
      {
        key: 'grunfeld-exchange-b',
        name: 'Exchange Variation',
        moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5', 'cxd5', 'Nxd5', 'e4', 'Nxc3', 'bxc3', 'Bg7'],
      },
      {
        key: 'grunfeld-russian-b',
        name: 'Russian System',
        moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5', 'Nf3', 'Bg7', 'Qb3'],
      },
      {
        key: 'grunfeld-fianchetto-b',
        name: 'Fianchetto Variation',
        moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5', 'g3', 'Bg7'],
      },
    ],
  },
];

export const CURATED_OPENINGS: CuratedOpening[] = [
  ...BASE_CURATED_OPENINGS,
  ...BASE_CURATED_OPENINGS.map(opening => mirrorOpeningForColor(opening, oppositeColor(opening.color))),
];

export function findOpening(key: string): ResolvedOpeningLine | undefined {
  for (const opening of CURATED_OPENINGS) {
    const found = findLine(opening, key, opening.color);
    if (found) return found;
  }
  return undefined;
}

export function flattenOpeningLines(): ResolvedOpeningLine[] {
  return CURATED_OPENINGS.flatMap(opening => flattenLine(opening, opening.color));
}

function findLine(line: OpeningLine, key: string, color: Color): ResolvedOpeningLine | undefined {
  if (line.key === key) return { ...line, color };
  for (const child of line.continuations ?? []) {
    const found = findLine(child, key, color);
    if (found) return found;
  }
  return undefined;
}

function flattenLine(line: OpeningLine, color: Color): ResolvedOpeningLine[] {
  return [
    { ...line, color },
    ...(line.continuations ?? []).flatMap(child => flattenLine(child, color)),
  ];
}

function mirrorOpeningForColor(opening: CuratedOpening, color: Color): CuratedOpening {
  return {
    ...mirrorLine(opening, color),
    color,
    name: `${color === 'w' ? 'White' : 'Black'} vs ${opening.name}`,
  };
}

function mirrorLine(line: OpeningLine, color: Color): OpeningLine {
  return {
    key: `${line.key}-as-${color}`,
    name: line.name,
    moves: line.moves,
    continuations: line.continuations?.map(child => mirrorLine(child, color)),
  };
}

function oppositeColor(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}
