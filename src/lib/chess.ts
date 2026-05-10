import { Chess } from 'chess.js';
import type { NormFen } from '../types';

// Strip halfmove clock and fullmove number from a FEN.
// Keeps: piece placement, side to move, castling, en passant.
export function normalizeFen(fen: string): NormFen {
  const parts = fen.split(' ');
  if (parts.length < 4) return fen;
  return parts.slice(0, 4).join(' ');
}

// A normalized FEN is missing the last two fields chess.js needs.
// Re-attach defaults so chess.js can load it.
export function denormalizeFen(normFen: NormFen): string {
  const parts = normFen.split(' ');
  if (parts.length >= 6) return normFen;
  return [...parts, '0', '1'].slice(0, 6).join(' ');
}

export const STARTING_FEN_NORM: NormFen = normalizeFen(new Chess().fen());

export function chessFromFen(normFen: NormFen): Chess {
  return new Chess(denormalizeFen(normFen));
}

export function turnAt(normFen: NormFen): 'w' | 'b' {
  return chessFromFen(normFen).turn();
}

// Play a sequence of SAN moves from the starting position and return the normalized FEN.
export function computeOpeningFen(moves: string[]): NormFen {
  const chess = new Chess();
  for (const move of moves) chess.move(move);
  return normalizeFen(chess.fen());
}

// Apply a move (SAN or {from,to,promotion}) to a normalized FEN.
// Returns null if illegal.
export function applyMove(
  normFen: NormFen,
  move: string | { from: string; to: string; promotion?: string }
): { fen: NormFen; san: string; uci: string; mover: 'w' | 'b' } | null {
  const chess = chessFromFen(normFen);
  const moverBefore = chess.turn();
  try {
    const m = chess.move(move);
    if (!m) return null;
    return {
      fen: normalizeFen(chess.fen()),
      san: m.san,
      uci: m.lan, // chess.js's "lan" is from+to+promotion, e.g. "e2e4", "e7e8q"
      mover: moverBefore,
    };
  } catch {
    return null;
  }
}
