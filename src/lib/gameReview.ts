import { Chess } from 'chess.js';
import type { Color, Edge, NormFen, Repertoire } from '../types';
import { normalizeFen } from './chess';
import { evaluateMoveCpLoss, pickYourMove, type YourMovePick } from './autosuggest';
import { getEdgesForRepertoire, getEdgesFromParent } from './storage';

export interface ReviewMoment {
  id: string;
  ply: number;
  moveNumber: number;
  fen: NormFen;
  playedSan: string;
  playedUci: string;
  preparedSan: string | null;
  preparedUci: string | null;
  inRepertoire: boolean;
  playedPrep: boolean;
  cpLoss: number | null;
  isFirstSeriousMistake: boolean;
  suggestion: YourMovePick | null;
  reason: string;
}

export interface GameReviewResult {
  white: string;
  black: string;
  result: string;
  side: Color;
  moments: ReviewMoment[];
  reviewedMoves: number;
}

const REVIEW_MAX_PLIES = 40;
const SERIOUS_MISTAKE_CP = 100;

export async function reviewGamePgn(rep: Repertoire, pgn: string, side: Color, signal?: AbortSignal): Promise<GameReviewResult> {
  const chess = new Chess();
  chess.loadPgn(pgn, { strict: false });
  const headers = chess.header();
  const allMoves = chess.history({ verbose: true }).slice(0, REVIEW_MAX_PLIES);
  const reachable = await getReachableFens(rep);
  const moments: ReviewMoment[] = [];
  let reviewedMoves = 0;
  let seriousMistakeSeen = false;

  for (const [moveIndex, move] of allMoves.entries()) {
    if (signal?.aborted) break;
    if (move.color !== side) continue;
    reviewedMoves++;

    const fen = normalizeFen(move.before);
    const inRepertoire = reachable.has(fen);
    const stored = await getEdgesFromParent(rep.id, fen);
    const prepared = stored.find(edge => edge.mover === side) ?? null;
    const playedPrep = Boolean(prepared && prepared.uci === move.lan);
    const evaluation = await evaluateMoveCpLoss(fen, move.lan, signal);
    const cpLoss = evaluation.cpLoss;
    const isSeriousMistake = cpLoss !== null && cpLoss >= SERIOUS_MISTAKE_CP;
    const isFirstSeriousMistake = isSeriousMistake && !seriousMistakeSeen;
    if (isSeriousMistake) seriousMistakeSeen = true;

    const suggestion = await pickYourMove(fen, side, signal);
    const suggestionIsDifferent = suggestion && suggestion.uci !== move.lan;
    const interesting = !playedPrep || isSeriousMistake || suggestionIsDifferent;
    if (!interesting) continue;

    moments.push({
      id: `${move.before}-${move.lan}-${moments.length}`,
      ply: moveIndex + 1,
      moveNumber: Math.floor(moveIndex / 2) + 1,
      fen,
      playedSan: move.san,
      playedUci: move.lan,
      preparedSan: prepared?.san ?? null,
      preparedUci: prepared?.uci ?? null,
      inRepertoire,
      playedPrep,
      cpLoss,
      isFirstSeriousMistake,
      suggestion: suggestionIsDifferent ? suggestion : null,
      reason: reasonForMoment({
        inRepertoire,
        prepared,
        playedPrep,
        isFirstSeriousMistake,
        isSeriousMistake,
        suggestion,
        playedUci: move.lan,
      }),
    });
  }

  return {
    white: String(headers.White ?? 'White'),
    black: String(headers.Black ?? 'Black'),
    result: String(headers.Result ?? '*'),
    side,
    moments,
    reviewedMoves,
  };
}

async function getReachableFens(rep: Repertoire): Promise<Set<NormFen>> {
  const edges = await getEdgesForRepertoire(rep.id);
  const byParent = new Map<NormFen, Edge[]>();
  for (const edge of edges) {
    const list = byParent.get(edge.parentFen) ?? [];
    list.push(edge);
    byParent.set(edge.parentFen, list);
  }
  const reachable = new Set<NormFen>([rep.rootFen]);
  const queue: NormFen[] = [rep.rootFen];
  while (queue.length) {
    const fen = queue.shift()!;
    for (const edge of byParent.get(fen) ?? []) {
      if (!reachable.has(edge.childFen)) {
        reachable.add(edge.childFen);
        queue.push(edge.childFen);
      }
    }
  }
  return reachable;
}

function reasonForMoment(input: {
  inRepertoire: boolean;
  prepared: Edge | null;
  playedPrep: boolean;
  isFirstSeriousMistake: boolean;
  isSeriousMistake: boolean;
  suggestion: YourMovePick | null;
  playedUci: string;
}): string {
  if (input.isFirstSeriousMistake) return 'First serious mistake';
  if (input.isSeriousMistake) return 'Engine flags this move';
  if (input.prepared && !input.playedPrep) return 'You left your prep';
  if (!input.inRepertoire) return 'Outside this repertoire';
  if (!input.prepared) return 'No saved prep here';
  if (input.suggestion && input.suggestion.uci !== input.playedUci) return 'A source prefers another move';
  return 'Worth checking';
}
