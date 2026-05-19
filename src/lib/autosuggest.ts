import type { Color, Edge, FrontierCandidate, FrontierSource, NormFen, ReadyLine, Repertoire } from '../types';
import { frontierId } from '../types';
import { applyMove, chessFromFen, STARTING_FEN_NORM, turnAt } from './chess';
import { fetchLocalEval, fetchExplorer, LichessAuthError, type CloudEvalResponse, type LichessExplorerResponse, type LichessMove } from './lichess';
import {
  addMovesToRepertoire,
  clearBlockedFrontiersForRepertoire,
  clearFrontiersForRepertoire,
  countReadyLines,
  getEdge,
  getEdgeById,
  getEdgesForRepertoire,
  getEdgesFromParent,
  getFrontiersForRepertoire,
  getOpenFrontiers,
  markFrontierAnswered,
  markFrontiersAnsweredByChildFen,
  markFrontierBlocked,
  playMoveInRepertoire,
  putEdge,
  putFrontiers,
  restoreGenerationState,
  snapshotGenerationState,
} from './storage';
import {
  comparePlayerBookCandidates,
  getPlayerBookCandidatesRaw,
  isPlayerBookCandidateTakeable,
  type PlayerBookPick,
  type PlayerBookSourceLine,
} from './playerBook';
import { getEnabledRecommendationOrder, getRecommendationSettings, type DatabaseSourceKey, type PlayerKey } from './recommendationSettings';

// Tunable knobs (per the spec we agreed).
export const TUNING = {
  evalThresholdPawn: 0.2,
  minGamesPerLine: 25,
  opponentPopularityFraction: 0.05, // 5%
  yourMoveAlpha: 0.5, // popularity weight
  yourMoveBeta: 0.5,  // win-rate weight
  mistakeThresholdPawn: 1.5,
  cloudEvalMultiPv: 5,
  // Stockfish depth used during line construction (per-move filter, ranking, opponent picks).
  engineDepthLineGen: 18,
  // Stockfish depth used for the post-generation quality gate (start + end FEN only).
  // Aligned with engineDepthSelect (22) — the picker chooses moves at depth 22, so the
  // gate must judge those choices at the same depth to avoid systematic disagreement
  // between picker and gate. (Previously 18 to align with engineDepthLineGen; that
  // alignment is moot now that the picker runs on local Stockfish at its true depth.)
  engineDepthGate: 22,
  // Stockfish depth used by the training UI's live eval panel ("Current" / "Line end").
  // Kept shallower than the gate so the panel populates in a few seconds, not 15+.
  engineDepthDisplay: 14,
  // Stockfish depth used when picking user moves via the engine fallback (no player-book
  // hit). Deeper than engineDepthLineGen because this is a one-shot best-move pick — no
  // rollout, no multi-pass. A previous multi-PV + 5-move rollout approach got fooled by
  // its own optimistic simulation (e.g., picking Be3 over Qxd4 because the rollout's
  // assumed Black replies were unrealistically weak — see docs/line-selection.md "Engine
  // rollout picker hazards"). Direct depth-22 best-move pick is simpler and avoids that
  // class of bug entirely.
  engineDepthSelect: 22,
  // Build worker fills the per-scope ready-line cache up to this many lines.
  readyLineCap: 3,
  // Single attempt per generation run. Retries within one run can't help — the picker
  // is deterministic per FEN, so a second attempt would build the same line. If a line
  // is rejected, the failure report is the next debugging step. Blocked-frontier state
  // is no longer used to alter retry behavior.
  qualityGateMaxAttempts: 1,
  // 30 minutes wall-clock. A full 5-user-move line at depth-22 needs ~10-15 serial
  // Stockfish evals; budgeting generously means timing out only signals a real bug.
  qualityGateTimeoutMs: 1_800_000,
  // Quality gate thresholds, per-mille (engine WDL sums to 1000). A user move fails
  // the gate if EITHER metric exceeds its threshold:
  //   expectedScoreDrop = expectedScore(best) - expectedScore(played) > maxWdlExpectedScoreDrop
  //   lossDelta         = played.loss - best.loss                     > maxWdlLossDelta
  // 35 is "balanced": a move drops practical chances by ~3.5 percentage points.
  // Presets: strict 20-25, balanced 35, faithful 50, loose 75.
  // Expected-score is the primary gate; loss-delta is a hard guard against moves
  // that swing position toward losing without much expected-score change.
  maxWdlExpectedScoreDrop: 35,
  maxWdlLossDelta: 35,
  // cp-loss fallback when WDL is missing (e.g., Lichess cloud fallback or older
  // engine output). Per-move centipawn loss vs engine-best; 100cp = Lichess
  // "mistake" threshold. Applied per user-move in the line, not aggregate.
  maxCpLossFallbackPerMove: 100,
  maxFrontierPlies: 32,
  // Historical name kept for compatibility with old docs. The frontier index is
  // no longer capped by this value; readyLineCap controls the small generated-line cache.
  frontierQueueTarget: 3,
  maxFrontierRebuildNodes: 180,
  maxFrontierFallbackNodes: 32,
  maxFrontierExplorerCalls: 60,
  maxFrontierFallbackExplorerCalls: 10,
  prepMinGamesPerBranch: 100,
  prepOpponentPopularityFraction: 0.08,
  prepMaxOpponentBranches: 5,
};

export type GenerationTrace = (message: string) => void;

function traceStep(trace: GenerationTrace | undefined, message: string): void {
  trace?.(message);
}

function describeError(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

class FrontierGenerationError extends Error {
  frontierId?: string;

  constructor(message: string, frontierId?: string) {
    super(message);
    this.name = 'FrontierGenerationError';
    this.frontierId = frontierId;
  }
}

// ---------- Pick YOUR move ----------

export interface YourMovePick {
  san: string;
  uci: string;
  source: 'player-book' | 'masters' | 'lichess-2000' | 'engine';
  evalCp?: number;
  popularityFraction?: number;
  winRate?: number;
  playerName?: string;
  playerNet?: number;
  playerWins?: number;
  playerDraws?: number;
  playerLosses?: number;
  sourceGameName?: string | null;
  playerBookCpLoss?: number | null;
  sourceLine?: PlayerBookSourceLine;
}

interface MovePop {
  san: string;
  uci: string;
  total: number;
  // Wins for the side whose turn it was (which is the user's color).
  yourWins: number;
  draws: number;
}

interface DirectMoveOptions {
  playerBookOnly?: boolean;
  skipPlayerBook?: boolean;
  skipEngineFallback?: boolean;
}

function moveToPop(m: LichessMove, color: Color): MovePop {
  const yourWins = color === 'w' ? m.white : m.black;
  return { san: m.san, uci: m.uci, total: m.white + m.draws + m.black, yourWins, draws: m.draws };
}

// Pick the user's preferred move at this position using the ordered sources in settings.
// Database candidates are filtered to moves within evalThresholdPawn of the engine's best,
// then ranked by alpha*popularity + beta*winrate.
export async function pickYourMove(fen: NormFen, color: Color, signal?: AbortSignal, trace?: GenerationTrace): Promise<YourMovePick | null> {
  const playerBookPick = await pickYourMoveDirect(fen, color, signal, trace, { playerBookOnly: true });
  if (playerBookPick) return playerBookPick;

  return pickYourMoveDirect(fen, color, signal, trace, { skipPlayerBook: true });
}

async function pickYourMoveDirect(
  fen: NormFen,
  color: Color,
  signal?: AbortSignal,
  trace?: GenerationTrace,
  options: DirectMoveOptions = {}
): Promise<YourMovePick | null> {
  const settings = await getRecommendationSettings();
  let enginePromise: Promise<CloudEvalResponse | null> | null = null;
  const getEngine = () => {
    if (!enginePromise) {
      traceStep(trace, `Your move picker: requesting engine eval at depth ${TUNING.engineDepthSelect}, fen=${fen}.`);
      enginePromise = fetchLocalEval(fen, TUNING.cloudEvalMultiPv, TUNING.engineDepthSelect, signal).then(engine => {
        if (!engine) {
          traceStep(trace, `Your move picker: local Stockfish unavailable (no fallback to Lichess cloud — depth-sensitive). Check that /api/stockfish/eval is reachable.`);
          return engine;
        }
        const got = engine.depth ?? 'unknown';
        const shortfall = typeof got === 'number' && got < TUNING.engineDepthSelect ? ` (requested ${TUNING.engineDepthSelect}, undershot by ${TUNING.engineDepthSelect - got})` : '';
        traceStep(trace, `Your move picker: engine returned ${engine.pvs.length} PVs at depth ${got}${shortfall}.`);
        return engine;
      });
    }
    return enginePromise;
  };

  const orderedSources = getEnabledRecommendationOrder(settings);
  traceStep(trace, `Your move picker: enabled sources=${orderedSources.map(source => source.kind === 'player-book' ? `player-book:${source.key}` : source.key).join(', ') || 'none'}.`);
  for (const source of orderedSources) {
    if (source.kind === 'player-book') {
      if (options.skipPlayerBook) continue;
      const playerPick = await pickEngineSafePlayerBookMove(
        source.key,
        fen,
        color,
        getEngine,
        signal,
        trace,
      );
      if (playerPick) {
        return playerBookPickToYourMove(playerPick);
      }
    } else {
      if (options.playerBookOnly) continue;
      const databasePick = await pickDatabaseMove(source.key, fen, color, getEngine, signal, trace);
      if (databasePick) {
        traceStep(trace, `Your move picker: database ${source.key} selected ${databasePick.san} (${databasePick.uci}).`);
        return databasePick;
      }
      traceStep(trace, `Your move picker: database ${source.key} had no usable move.`);
    }
  }

  if (options.playerBookOnly) {
    traceStep(trace, 'Your move picker: no engine-safe player-book move found.');
    return null;
  }

  if (options.skipEngineFallback) {
    traceStep(trace, 'Your move picker: direct engine fallback skipped for rollout simulation.');
    return null;
  }

  const engine = await getEngine();
  if (!engine || engine.pvs.length === 0) {
    traceStep(trace, 'Your move picker: no enabled source and no engine fallback move.');
    return null;
  }
  const bestUci = engine.pvs[0].moves.split(' ')[0];
  const m = applyMove(fen, uciToObj(bestUci));
  if (!m) {
    traceStep(trace, `Your move picker: engine best move ${bestUci} could not be applied.`);
    return null;
  }
  traceStep(trace, `Your move picker: engine fallback selected ${m.san} (${m.uci}).`);
  return { san: m.san, uci: m.uci, source: 'engine', evalCp: pvCpForColor(engine.pvs[0], color) ?? undefined };
}

// Lenient fallback: pick the most popular move from masters or lichess with no game-count floor.
// Used when pickYourMove fails (position too rare for the 25-game threshold or cloud eval uncached).
async function pickAnyDatabaseMove(fen: NormFen, color: Color, signal?: AbortSignal, trace?: GenerationTrace): Promise<YourMovePick | null> {
  const queries: Array<[DatabaseSourceKey, Parameters<typeof fetchExplorer>[1]]> = [
    ['masters', { source: 'masters' }],
    ['lichess-2000', { source: 'lichess', speeds: 'rapid,classical', ratings: '2000,2200,2500' }],
    // Broadest possible: all speeds, all ratings — catches rare middlegame positions
    ['lichess-2000', { source: 'lichess' }],
  ];
  for (const [sourceKey, opts] of queries) {
    try {
      traceStep(trace, `Lenient user move fallback: querying ${sourceKey} with no game-count floor.`);
      const resp = await fetchExplorer(fen, opts, signal);
      const candidates = resp.moves.map(m => moveToPop(m, color)).filter(m => m.total > 0);
      traceStep(trace, `Lenient user move fallback: ${sourceKey} returned ${candidates.length} candidates.`);
      if (candidates.length === 0) continue;
      const winner = rankCandidates(candidates);
      traceStep(trace, `Lenient user move fallback: selected ${winner.san} (${winner.uci}) from ${sourceKey}.`);
      return { san: winner.san, uci: winner.uci, source: sourceKey };
    } catch (e) {
      if (e instanceof LichessAuthError) throw e;
      traceStep(trace, `Lenient user move fallback: ${sourceKey} failed: ${describeError(e)}`);
    }
  }
  traceStep(trace, 'Lenient user move fallback: no database move found.');
  return null;
}

// Player-book picker with staged trace. Filters in five stages so each
// rejection is legible in the genTrace:
//   1) raw lookup    — was the position found in this player's book at all?
//   2) legality      — does each raw candidate apply to this FEN? (catches
//                      FEN-normalisation mismatches; normally zero)
//   3) result gate   — `wins > losses` (book-internal result-based gate)
//   4) WDL/cp gate   — shared `judgeCandidateAtFen` (identical to the per-move
//                      quality gate, so any survivor is structurally
//                      guaranteed to pass the gate downstream)
//   5) selection     — first survivor after `compareCandidates` sort wins
// See docs/line-selection.md → User-move selection → Player-book selection.
async function pickEngineSafePlayerBookMove(
  playerKey: PlayerKey,
  fen: NormFen,
  color: Color,
  getEngine: () => Promise<CloudEvalResponse | null>,
  signal?: AbortSignal,
  trace?: GenerationTrace,
): Promise<(PlayerBookPick & { cpLoss: number | null }) | null> {
  const lookup = await getPlayerBookCandidatesRaw(playerKey, fen, color, signal);
  const label = lookup.playerName ? `${lookup.playerName} (${playerKey})` : playerKey;
  const raw = lookup.rawCandidates;

  if (raw.length === 0) {
    traceStep(trace, `Player book picker: ${label} — 0 matching moves at normalized FEN ${lookup.positionKey}.`);
    return null;
  }
  traceStep(trace, `Player book picker: ${label} — ${raw.length} raw matching move(s) at normalized FEN ${lookup.positionKey}.`);

  // Stage 2: legality.
  const legal: PlayerBookPick[] = [];
  let illegalCount = 0;
  for (const c of raw) {
    if (applyMove(fen, uciToObj(c.uci))) {
      legal.push(c);
    } else {
      illegalCount++;
      traceStep(trace, `Player book picker: rejected by legality: ${c.san} (${c.uci}) not applicable to ${fen}.`);
    }
  }

  // Stage 3: result gate (wins > losses).
  const resultSurvivors: PlayerBookPick[] = [];
  let resultRejectedCount = 0;
  for (const c of legal) {
    if (isPlayerBookCandidateTakeable(c)) {
      resultSurvivors.push(c);
    } else {
      resultRejectedCount++;
      const net = c.wins - c.losses;
      traceStep(trace, `Player book picker: rejected by result gate: ${c.san} W=${c.wins} D=${c.draws} L=${c.losses} net=${net} (threshold: net>0).`);
    }
  }

  // Stage 4: WDL/cp engine gate via the shared helper. One parent eval reused.
  const parentEval = resultSurvivors.length > 0 ? await getEngine() : null;
  const enginePassed: Array<PlayerBookPick & { cpLoss: number | null; expectedScoreDrop: number | null; lossDelta: number | null }> = [];
  const engineRejected: Array<PlayerBookPick & { judgment: CandidateJudgment }> = [];
  for (const c of resultSurvivors) {
    const j = await judgeCandidateAtFen(fen, c.uci, color, signal, parentEval);
    if (j.passed) {
      enginePassed.push({ ...c, cpLoss: j.cpLoss, expectedScoreDrop: j.expectedScoreDrop, lossDelta: j.lossDelta });
    } else {
      engineRejected.push({ ...c, judgment: j });
      traceStep(trace, formatPlayerBookRejection(c, j));
    }
  }

  if (enginePassed.length === 0) {
    const best = pickBestEngineRejection(engineRejected);
    const tail = best ? ` best rejected was ${best.san} ${formatRejectionMetrics(best.judgment)}.` : '';
    traceStep(trace, `Player book ${label}: ${raw.length} raw moves; ${illegalCount} illegal; ${resultRejectedCount} rejected by result gate; ${engineRejected.length} rejected by engine gate.${tail}`);
    return null;
  }

  // Stage 5: sort engine-passed candidates by `compareCandidates` and pick the top.
  enginePassed.sort(comparePlayerBookCandidates);
  const winner = enginePassed[0];
  const cpStr = winner.cpLoss !== null ? ` cpLoss=${winner.cpLoss.toFixed(0)}` : '';
  const wdlStr = winner.expectedScoreDrop !== null && winner.lossDelta !== null
    ? ` expectedScoreDrop=${winner.expectedScoreDrop.toFixed(1)}‰ lossDelta=${winner.lossDelta.toFixed(1)}‰`
    : '';
  traceStep(trace, `Player book ${label}: ${raw.length} raw moves; ${illegalCount} illegal; ${resultRejectedCount} rejected by result gate; ${engineRejected.length} rejected by engine gate; selected ${winner.san} (${winner.uci})${wdlStr}${cpStr}.`);
  return { ...winner, cpLoss: winner.cpLoss };
}

function formatPlayerBookRejection(c: PlayerBookPick, j: CandidateJudgment): string {
  if (j.verdict === 'mate-lost') {
    return `Player book picker: rejected by mate-lost guard: ${c.san}; winning mate ${j.bestSan ?? j.bestUci ?? '?'} was available.`;
  }
  if (j.verdict === 'wdl') {
    const cpStr = j.cpLoss !== null ? ` cpLoss=${j.cpLoss.toFixed(0)}` : '';
    return `Player book picker: rejected by WDL gate: ${c.san} (${c.uci}) bestWdl=${fmtWdl(j.bestWdl)} playedWdl=${fmtWdl(j.playedWdl)} expectedScoreDrop=${j.expectedScoreDrop!.toFixed(1)}‰ (max ${TUNING.maxWdlExpectedScoreDrop}) lossDelta=${j.lossDelta!.toFixed(1)}‰ (max ${TUNING.maxWdlLossDelta})${cpStr} — ${j.classification.toUpperCase()}.`;
  }
  if (j.verdict === 'cp-fallback') {
    return `Player book picker: rejected by cp fallback: ${c.san} cpLoss=${j.cpLoss!.toFixed(0)} > maxCpLossFallbackPerMove (${TUNING.maxCpLossFallbackPerMove}) — investigate UCI_ShowWDL.`;
  }
  // 'engine-unavailable' / 'engine-unavailable-child' branches return passed=true,
  // so they don't reach this formatter. Defensive fallback:
  return `Player book picker: rejected ${c.san} (${c.uci}) verdict=${j.verdict} classification=${j.classification}.`;
}

function pickBestEngineRejection(rejected: Array<PlayerBookPick & { judgment: CandidateJudgment }>): (PlayerBookPick & { judgment: CandidateJudgment }) | null {
  if (rejected.length === 0) return null;
  // "Best" = smallest expected-score drop (or cp-loss when WDL absent).
  return [...rejected].sort((a, b) => {
    const ad = a.judgment.expectedScoreDrop ?? a.judgment.cpLoss ?? Number.POSITIVE_INFINITY;
    const bd = b.judgment.expectedScoreDrop ?? b.judgment.cpLoss ?? Number.POSITIVE_INFINITY;
    return ad - bd;
  })[0];
}

function formatRejectionMetrics(j: CandidateJudgment): string {
  if (j.verdict === 'wdl') {
    return `expectedScoreDrop=${j.expectedScoreDrop!.toFixed(1)}‰ (over ${TUNING.maxWdlExpectedScoreDrop}) lossDelta=${j.lossDelta!.toFixed(1)}‰ (over ${TUNING.maxWdlLossDelta})`;
  }
  if (j.verdict === 'cp-fallback') {
    return `cpLoss=${j.cpLoss!.toFixed(0)} (over ${TUNING.maxCpLossFallbackPerMove})`;
  }
  if (j.verdict === 'mate-lost') return 'mate-lost';
  return j.verdict;
}

function fmtWdl(w: WdlVec | null): string {
  return w ? `${w.win}/${w.draw}/${w.loss}` : '?/?/?';
}

function playerBookPickToYourMove(playerPick: PlayerBookPick & { cpLoss?: number | null }): YourMovePick {
  return {
    san: playerPick.san,
    uci: playerPick.uci,
    source: 'player-book',
    popularityFraction: 1,
    playerName: playerPick.playerName,
    playerNet: playerPick.net,
    playerWins: playerPick.wins,
    playerDraws: playerPick.draws,
    playerLosses: playerPick.losses,
    sourceGameName: playerPick.sourceGameName,
    playerBookCpLoss: playerPick.cpLoss ?? null,
    sourceLine: playerPick.sourceLine,
  };
}

async function pickDatabaseMove(
  source: DatabaseSourceKey,
  fen: NormFen,
  color: Color,
  getEngine: () => Promise<CloudEvalResponse | null>,
  signal?: AbortSignal,
  trace?: GenerationTrace
): Promise<YourMovePick | null> {
  let candidates: MovePop[] = [];
  try {
    traceStep(trace, `Your move picker: querying ${source} Explorer at ${fen}.`);
    const response = source === 'masters'
      ? await fetchExplorer(fen, { source: 'masters' }, signal)
      : await fetchExplorer(fen, {
        source: 'lichess',
        speeds: 'rapid,classical',
        ratings: '2000,2200,2500',
      }, signal);
    candidates = response.moves.map(m => moveToPop(m, color)).filter(m => m.total >= TUNING.minGamesPerLine);
    traceStep(trace, `Your move picker: ${source} returned ${response.moves.length} moves; ${candidates.length} meet minGames=${TUNING.minGamesPerLine}.`);
  } catch (e) {
    if (e instanceof LichessAuthError) throw e;
    traceStep(trace, `Your move picker: ${source} Explorer failed: ${describeError(e)}`);
    return null;
  }
  if (candidates.length === 0) {
    traceStep(trace, `Your move picker: ${source} has no candidate above minGames.`);
    return null;
  }

  const engine = await getEngine();
  const filtered = filterByEngineEval(candidates, color, engine);
  traceStep(trace, `Your move picker: ${source} candidates after engine filter=${filtered.length}; engineAvailable=${Boolean(engine?.pvs.length)}.`);
  const winner = rankCandidates(filtered.length > 0 ? filtered : candidates);
  const bestPv = engine ? findPvForMove(engine, winner.uci) : null;
  return {
    san: winner.san,
    uci: winner.uci,
    source,
    evalCp: bestPv ? (pvCpForColor(bestPv, color) ?? undefined) : undefined,
    popularityFraction: winner.total > 0 ? winner.total / sumTotals(candidates) : 0,
    winRate: decisivenessRate(winner),
  };
}

function sumTotals(arr: MovePop[]): number {
  let s = 0;
  for (const a of arr) s += a.total;
  return s;
}

// wins / (total - draws); 0 if no decisive games.
function decisivenessRate(m: MovePop): number {
  const decisive = m.total - m.draws;
  if (decisive <= 0) return 0;
  return m.yourWins / decisive;
}

function rankCandidates(arr: MovePop[]): MovePop {
  // Normalize popularity to [0,1] and decisiveness rate to [0,1].
  const totalGames = sumTotals(arr) || 1;
  let bestScore = -Infinity;
  let best = arr[0];
  for (const m of arr) {
    const pop = m.total / totalGames;
    const wr = decisivenessRate(m);
    const score = TUNING.yourMoveAlpha * pop + TUNING.yourMoveBeta * wr;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

function filterByEngineEval(candidates: MovePop[], color: Color, engine: CloudEvalResponse | null): MovePop[] {
  if (!engine || engine.pvs.length === 0) return candidates;
  const bestCp = pvCpForColor(engine.pvs[0], color);
  if (bestCp === null) return candidates;
  const minCp = bestCp - TUNING.evalThresholdPawn * 100;
  // Only candidates whose engine eval is within threshold survive.
  // If a candidate isn't in engine PVs, we're conservative and exclude it.
  const out: MovePop[] = [];
  for (const c of candidates) {
    const pv = findPvForMove(engine, c.uci);
    if (!pv) continue;
    const cp = pvCpForColor(pv, color);
    if (cp === null) continue;
    if (cp >= minCp) out.push(c);
  }
  return out;
}

export function findPvForMove(engine: CloudEvalResponse, uci: string): import('./lichess').CloudEvalPv | null {
  for (const pv of engine.pvs) {
    if (pv.moves.split(' ')[0] === uci) return pv;
  }
  return null;
}

// Lichess cloud-eval cp is from White's perspective. Higher = better for White.
// Mate scores use the same sign convention. Convert to a large cp number.
export function pvCpForWhite(pv: import('./lichess').CloudEvalPv): number | null {
  if (pv.cp !== undefined) return pv.cp;
  if (pv.mate !== undefined) return pv.mate > 0 ? 100000 - pv.mate : -100000 - pv.mate;
  return null;
}

export function pvCpForColor(pv: import('./lichess').CloudEvalPv, color: Color): number | null {
  const cp = pvCpForWhite(pv);
  return cp === null ? null : color === 'w' ? cp : -cp;
}

export const pvCpForSide = pvCpForWhite;

export function uciToObj(uci: string): { from: string; to: string; promotion?: string } {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci.slice(4) : undefined };
}

// Evaluate a candidate move at `fen`: returns its centipawn loss vs engine's best.
// If the move isn't in the top PVs, makes a follow-up cloud-eval call on the resulting position.
// Returns null cpLoss if no engine data available.
export interface MoveEvaluation {
  cpLoss: number | null;
  best: { uci: string; san: string; cp: number } | null;
  attemptedSan: string | null;
}

export async function evaluateMoveCpLoss(fen: NormFen, attemptedUci: string, signal?: AbortSignal): Promise<MoveEvaluation> {
  const engine = await fetchLocalEval(fen, TUNING.cloudEvalMultiPv, TUNING.engineDepthLineGen, signal);
  const attempted = applyMove(fen, uciToObj(attemptedUci));
  const attemptedSan = attempted?.san ?? null;
  if (!engine || engine.pvs.length === 0) return { cpLoss: null, best: null, attemptedSan };
  const bestPv = engine.pvs[0];
  const mover = turnAt(fen);
  const bestCp = pvCpForColor(bestPv, mover);
  if (bestCp === null) return { cpLoss: null, best: null, attemptedSan };
  const bestUci = bestPv.moves.split(' ')[0];
  const bestApplied = applyMove(fen, uciToObj(bestUci));
  const bestSan = bestApplied?.san ?? bestUci;
  const best = { uci: bestUci, san: bestSan, cp: bestCp };
  const pv = findPvForMove(engine, attemptedUci);
  if (pv) {
    const cp = pvCpForColor(pv, mover);
    if (cp === null) return { cpLoss: null, best, attemptedSan };
    return { cpLoss: bestCp - cp, best, attemptedSan };
  }
  if (!attempted) return { cpLoss: null, best, attemptedSan };
  const post = await fetchLocalEval(attempted.fen, 1, TUNING.engineDepthLineGen, signal);
  if (!post || post.pvs.length === 0) return { cpLoss: null, best, attemptedSan };
  const postCp = pvCpForColor(post.pvs[0], mover);
  if (postCp === null) return { cpLoss: null, best, attemptedSan };
  return { cpLoss: bestCp - postCp, best, attemptedSan };
}

// ---------- Line-quality gate ----------

// Tiered max-allowed eval drop based on the line's starting eval (in pawns, from the
// user's color). Negative starting evals (user is already worse) are treated as 0 to
// apply the strictest threshold — we don't want a worse-off line to bleed further.
export function maxAllowedDropPawns(startPawns: number): number {
  const bucket = Math.max(0, startPawns);
  if (bucket <= 1) return 0.5;
  if (bucket <= 3) return 0.75;
  if (bucket <= 4) return 1.0;
  if (bucket <= 5) return 2.0;
  return 3.0;
}

// ---------- WDL helpers (Win / Draw / Loss probability) ----------

// Per-mille vector: each value 0..1000, summing to 1000. Reported by Stockfish
// when UCI_ShowWDL is enabled. Always from the side-to-move's perspective at
// the position being evaluated — so if we evaluate a position where the user
// is to move, the engine reports the user's W/D/L if it plays the PV.
export type WdlVec = { win: number; draw: number; loss: number };

// Expected score in per-mille (0..1000). 1000 = guaranteed win,
// 0 = guaranteed loss, 500 = balanced. Used as the primary line-quality gate
// because it correctly distinguishes "this move drops practical chances" from
// "this move barely changes anything." Centipawn loss conflates these.
export function expectedScoreFromWdl(w: WdlVec): number {
  return w.win + 0.5 * w.draw;
}

// Invert a WDL vector to the opposite color's perspective. Win and loss swap;
// draw is unchanged. Needed when we evaluate a position from the opponent's
// side-to-move and want to project the user's W/D/L.
function invertWdl(w: WdlVec): WdlVec {
  return { win: w.loss, draw: w.draw, loss: w.win };
}

// ---------- Line-quality gate ----------

export type MoveClassification =
  | 'best'        // ~no loss
  | 'good'        // small loss, well within thresholds
  | 'inaccuracy'  // visible loss but passes the gate
  | 'mistake'     // fails the gate by exceeding wdl/cp thresholds
  | 'blunder'     // fails the gate by a large margin
  | 'mateLost'   // played a non-mate when a winning mate existed
  | 'unknown';    // could not measure (engine unavailable for this position)

export interface UserMoveQuality {
  ply: number;           // index in fullPath
  san: string;           // played SAN
  uci: string;
  parentFen: NormFen;
  bestUci: string | null;
  bestSan: string | null;
  // WDL path (primary). null when WDL is not available from the engine output.
  bestWdl: WdlVec | null;
  playedWdl: WdlVec | null;
  expectedScoreDrop: number | null;  // per-mille, >0 means played worse than best
  lossDelta: number | null;          // per-mille, >0 means more loss probability
  // cp-loss (always reported when available) — used as fallback gate.
  bestCp: number | null;
  playedCp: number | null;
  cpLoss: number | null;             // centipawns, >0 means played worse
  classification: MoveClassification;
  passed: boolean;
  reason: string;
}

export interface LineQualityResult {
  passed: boolean;
  moves: UserMoveQuality[];
  worst: UserMoveQuality | null;
  reason: string;
  mateLost: boolean;
  // Worst single-move cp loss, kept for backward-compat with the ReadyLine.qualityDropCp
  // column that's displayed in the line-queue UI. Null when not measurable.
  dropCp: number | null;
  // The old start/end/threshold fields are preserved for type-shape stability but
  // are no longer populated by the per-move gate (always null/0).
  startCp: number | null;
  endCp: number | null;
  thresholdCp: number;
}

function isWinningMate(cp: number | null): boolean {
  return cp !== null && cp > 90000;
}

// Tag for which gate path produced the pass/fail decision. Used by callers
// (per-move quality gate and player-book picker) to format trace strings.
export type CandidateGateVerdict =
  | 'engine-unavailable'        // parent multi-PV missing — unmeasurable, passed defaulted true
  | 'engine-unavailable-child'  // played move outside multi-PV AND child eval missing — unmeasurable
  | 'mate-lost'                 // best PV is a winning mate, played move isn't — failed
  | 'wdl'                       // WDL gate decided the verdict
  | 'cp-fallback';              // cp-loss gate decided (WDL absent)

// Shared numeric judgment used by both the per-move quality gate
// (`evaluateUserMove`) and the player-book picker
// (`pickEngineSafePlayerBookMove`). Caller supplies the multi-PV parent eval
// so that several candidates at the same parent FEN can reuse one fetch.
export interface CandidateJudgment {
  bestUci: string | null;
  bestSan: string | null;
  bestWdl: WdlVec | null;
  playedWdl: WdlVec | null;
  expectedScoreDrop: number | null;
  lossDelta: number | null;
  bestCp: number | null;
  playedCp: number | null;
  cpLoss: number | null;
  classification: MoveClassification;
  passed: boolean;
  verdict: CandidateGateVerdict;
}

// Single source of truth for the WDL/cp-fallback/mate-loss gate. Picker and
// quality gate both delegate here so a candidate that survives the picker is
// guaranteed to survive the gate (modulo parent-eval depth, which is
// equalised by setting `engineDepthSelect === engineDepthGate`).
async function judgeCandidateAtFen(
  parentFen: NormFen,
  uci: string,
  color: Color,
  signal: AbortSignal | undefined,
  parentEval: CloudEvalResponse | null,
): Promise<CandidateJudgment> {
  const base: CandidateJudgment = {
    bestUci: null, bestSan: null,
    bestWdl: null, playedWdl: null,
    expectedScoreDrop: null, lossDelta: null,
    bestCp: null, playedCp: null, cpLoss: null,
    classification: 'unknown',
    passed: true,
    verdict: 'engine-unavailable',
  };
  if (!parentEval || parentEval.pvs.length === 0) return base;

  const bestPv = parentEval.pvs[0];
  base.bestCp = pvCpForColor(bestPv, color);
  base.bestWdl = bestPv.wdl ?? null;
  base.bestUci = bestPv.moves.split(' ')[0] || null;
  if (base.bestUci) {
    const bestApplied = applyMove(parentFen, uciToObj(base.bestUci));
    base.bestSan = bestApplied?.san ?? base.bestUci;
  }

  // Played move's metrics: prefer in-multi-PV, else evaluate child and invert.
  const playedPv = findPvForMove(parentEval, uci);
  if (playedPv) {
    base.playedCp = pvCpForColor(playedPv, color);
    base.playedWdl = playedPv.wdl ?? null;
  } else {
    const applied = applyMove(parentFen, uciToObj(uci));
    if (!applied) {
      base.verdict = 'engine-unavailable-child';
      return base;
    }
    const childEval = await fetchLocalEval(applied.fen as NormFen, 1, TUNING.engineDepthGate, signal);
    if (childEval && childEval.pvs.length > 0) {
      const childTop = childEval.pvs[0];
      base.playedCp = pvCpForColor(childTop, color);
      base.playedWdl = childTop.wdl ? invertWdl(childTop.wdl) : null;
    } else {
      base.verdict = 'engine-unavailable-child';
      return base;
    }
  }

  if (base.bestCp !== null && base.playedCp !== null) {
    base.cpLoss = base.bestCp - base.playedCp;
  }
  if (base.bestWdl && base.playedWdl) {
    base.expectedScoreDrop = expectedScoreFromWdl(base.bestWdl) - expectedScoreFromWdl(base.playedWdl);
    base.lossDelta = base.playedWdl.loss - base.bestWdl.loss;
  }

  if (isWinningMate(base.bestCp) && !isWinningMate(base.playedCp)) {
    base.classification = 'mateLost';
    base.passed = false;
    base.verdict = 'mate-lost';
    return base;
  }

  if (base.expectedScoreDrop !== null && base.lossDelta !== null) {
    const failed = base.expectedScoreDrop > TUNING.maxWdlExpectedScoreDrop
                || base.lossDelta > TUNING.maxWdlLossDelta;
    base.classification = classifyByWdl(base.expectedScoreDrop, base.lossDelta);
    base.passed = !failed;
    base.verdict = 'wdl';
    return base;
  }

  if (base.cpLoss !== null) {
    const failed = base.cpLoss > TUNING.maxCpLossFallbackPerMove;
    base.classification = classifyByCpLoss(base.cpLoss);
    base.passed = !failed;
    base.verdict = 'cp-fallback';
    return base;
  }

  base.verdict = 'engine-unavailable-child';
  return base;
}

// Evaluate ONE user move's quality vs the engine's best at the parent FEN.
// Thin wrapper over the shared `judgeCandidateAtFen` helper that adds
// edge-aware trace prose. Delegating here keeps the picker and the gate on
// identical numerics — see DO NOT bullet in docs/line-selection.md.
async function evaluateUserMove(
  edge: Edge,
  ply: number,
  color: Color,
  signal: AbortSignal | undefined,
  trace?: GenerationTrace
): Promise<UserMoveQuality> {
  const parentFen = edge.parentFen as NormFen;
  const parentEval = await fetchLocalEval(parentFen, TUNING.cloudEvalMultiPv, TUNING.engineDepthGate, signal);
  if (!parentEval || parentEval.pvs.length === 0) {
    traceStep(trace, `Quality gate: engine unavailable at ${edge.san} (parentFen=${parentFen}); skipping this move.`);
  }
  const j = await judgeCandidateAtFen(parentFen, edge.uci, color, signal, parentEval);
  const { verdict, ...common } = j;

  let reason: string;
  switch (verdict) {
    case 'engine-unavailable':
      reason = 'Engine unavailable; this move could not be judged.';
      break;
    case 'engine-unavailable-child':
      traceStep(trace, `Quality gate: engine unavailable at child position for ${edge.san} (childFen=${edge.childFen}); cannot score this move.`);
      reason = 'Engine unavailable for follow-up eval; this move could not be judged.';
      break;
    case 'mate-lost':
      reason = `Played ${edge.san} but a winning mate (${j.bestSan ?? j.bestUci}) was available.`;
      break;
    case 'wdl': {
      const dropStr = `expectedDrop=${j.expectedScoreDrop!.toFixed(1)} (max ${TUNING.maxWdlExpectedScoreDrop})`;
      const lossStr = `lossDelta=${j.lossDelta!.toFixed(1)} (max ${TUNING.maxWdlLossDelta})`;
      const cpStr = j.cpLoss !== null ? ` cpLoss=${j.cpLoss.toFixed(0)}` : '';
      reason = j.passed
        ? `Played ${edge.san}: ${dropStr}, ${lossStr}${cpStr} — ${j.classification}.`
        : `Played ${edge.san}: ${dropStr}, ${lossStr}${cpStr} — ${j.classification.toUpperCase()}.`;
      break;
    }
    case 'cp-fallback':
      reason = j.passed
        ? `Played ${edge.san}: cpLoss=${j.cpLoss!.toFixed(0)} (no WDL) — ${j.classification}.`
        : `Played ${edge.san}: cpLoss=${j.cpLoss!.toFixed(0)} > ${TUNING.maxCpLossFallbackPerMove} (no WDL) — ${j.classification.toUpperCase()}.`;
      break;
  }

  return { ply, san: edge.san, uci: edge.uci, parentFen, ...common, reason };
}

function classifyByWdl(expectedScoreDrop: number, lossDelta: number): MoveClassification {
  const worst = Math.max(expectedScoreDrop, lossDelta);
  if (worst <= 10) return 'best';
  if (worst <= TUNING.maxWdlExpectedScoreDrop) return 'good';
  if (worst <= 80) return 'inaccuracy';
  if (worst <= 150) return 'mistake';
  return 'blunder';
}

function classifyByCpLoss(cpLoss: number): MoveClassification {
  if (cpLoss <= 10) return 'best';
  if (cpLoss < 50) return 'good';
  if (cpLoss < TUNING.maxCpLossFallbackPerMove) return 'inaccuracy';
  if (cpLoss < 300) return 'mistake';
  return 'blunder';
}

// Walk every user-color move in the generated portion of the line and judge
// it individually. The line FAILS the gate iff any user move fails (WDL
// thresholds when available, cp-loss fallback otherwise). Moves whose engine
// eval is unavailable are skipped (treated as pass, can't judge what we can't
// measure) — but at least one judgeable move is required for a verdict.
export async function evaluateLineQuality(
  line: GeneratedLine,
  color: Color,
  signal?: AbortSignal,
  trace?: GenerationTrace
): Promise<LineQualityResult> {
  const generated = line.fullPath.slice(line.generationStartIndex);
  const userEdges: { edge: Edge; ply: number }[] = [];
  for (let i = 0; i < generated.length; i++) {
    const edge = generated[i];
    if (edge.mover === color) userEdges.push({ edge, ply: line.generationStartIndex + i });
  }

  const passResult = (reason: string): LineQualityResult => ({
    passed: true, moves: [], worst: null, reason, mateLost: false,
    dropCp: null, startCp: null, endCp: null, thresholdCp: 0,
  });

  if (userEdges.length === 0) {
    traceStep(trace, `Quality gate: SKIP — no user moves in generated portion of the line.`);
    return passResult('No user moves in generated portion');
  }

  traceStep(trace, `Quality gate: walking ${userEdges.length} user move${userEdges.length === 1 ? '' : 's'} at depth ${TUNING.engineDepthGate}.`);

  const moves: UserMoveQuality[] = [];
  for (const { edge, ply } of userEdges) {
    if (signal?.aborted) {
      traceStep(trace, `Quality gate: aborted mid-walk after ${moves.length} of ${userEdges.length} user moves.`);
      break;
    }
    const m = await evaluateUserMove(edge, ply, color, signal, trace);
    moves.push(m);
    traceStep(trace, `Quality gate: move ${ply + 1} (${edge.san}) → ${m.reason}`);
    // Short-circuit on first hard failure so we don't waste evals.
    if (!m.passed) break;
  }

  // Worst move = lowest-quality among judged moves. Mate-loss > blunder > mistake > inaccuracy > good > best.
  const severity: Record<MoveClassification, number> = {
    mateLost: 6, blunder: 5, mistake: 4, inaccuracy: 3, good: 2, best: 1, unknown: 0,
  };
  let worst: UserMoveQuality | null = null;
  for (const m of moves) {
    if (!worst || severity[m.classification] > severity[worst.classification]) worst = m;
  }

  const failedMove = moves.find(m => !m.passed) ?? null;
  const mateLost = moves.some(m => m.classification === 'mateLost');
  const dropCp = worst && worst.cpLoss !== null ? worst.cpLoss : null;

  if (failedMove) {
    const reason = failedMove.reason;
    traceStep(trace, `Quality gate: FAIL — ${reason}`);
    return {
      passed: false, moves, worst: failedMove, reason, mateLost,
      dropCp, startCp: null, endCp: null, thresholdCp: 0,
    };
  }

  // No hard failure. Surface inaccuracies as informational.
  const inaccuracies = moves.filter(m => m.classification === 'inaccuracy');
  const reason = inaccuracies.length > 0
    ? `All user moves passed; ${inaccuracies.length} flagged as inaccuracy (${inaccuracies.map(m => m.san).join(', ')}).`
    : 'All user moves passed.';
  traceStep(trace, `Quality gate: PASS — ${reason}`);
  return {
    passed: true, moves, worst, reason, mateLost: false,
    dropCp, startCp: null, endCp: null, thresholdCp: 0,
  };
}

// ---------- Pick OPPONENT moves to enumerate ----------

export interface OpponentMove {
  san: string;
  uci: string;
  popularityFraction: number;
  isMistake: boolean;
}

export interface PrepOpponentBranch {
  parentFen: NormFen;
  childFen: NormFen;
  san: string;
  uci: string;
  games: number;
  popularityFraction: number;
}

export interface PrepMoveWarning {
  kind: 'database-losses';
  san: string;
  uci: string;
  total: number;
  wins: number;
  draws: number;
  losses: number;
}

export async function getPrepOpponentBranches(
  fen: NormFen,
  signal?: AbortSignal,
  trace?: GenerationTrace
): Promise<PrepOpponentBranch[]> {
  traceStep(trace, `Prep map: querying opponent branches at ${fen}.`);
  const resp = await fetchExplorer(fen, { source: 'lichess' }, signal);
  const total = resp.white + resp.draws + resp.black;
  if (total <= 0) {
    traceStep(trace, 'Prep map: Explorer returned zero games for this position.');
    return [];
  }

  const branches: PrepOpponentBranch[] = [];
  for (const move of resp.moves) {
    const games = move.white + move.draws + move.black;
    const popularityFraction = games / total;
    if (games < TUNING.prepMinGamesPerBranch) continue;
    if (popularityFraction < TUNING.prepOpponentPopularityFraction) continue;
    const applied = applyMove(fen, uciToObj(move.uci)) ?? applyMove(fen, move.san);
    if (!applied) continue;
    branches.push({
      parentFen: fen,
      childFen: applied.fen,
      san: applied.san,
      uci: applied.uci,
      games,
      popularityFraction,
    });
  }
  branches.sort((a, b) => (b.popularityFraction - a.popularityFraction) || (b.games - a.games));
  const capped = branches.slice(0, TUNING.prepMaxOpponentBranches);
  traceStep(trace, `Prep map: found ${branches.length} opponent branches above threshold; using top ${capped.length}.`);
  return capped;
}

export async function getPrepMoveWarning(
  fen: NormFen,
  attemptedUci: string,
  color: Color,
  signal?: AbortSignal
): Promise<PrepMoveWarning | null> {
  let resp: LichessExplorerResponse;
  try {
    resp = await fetchExplorer(fen, { source: 'lichess' }, signal);
  } catch (e) {
    if (e instanceof LichessAuthError) throw e;
    return null;
  }
  const row = resp.moves.find(move => move.uci === attemptedUci);
  if (!row) return null;
  const total = row.white + row.draws + row.black;
  if (total < TUNING.minGamesPerLine) return null;
  const wins = color === 'w' ? row.white : row.black;
  const losses = color === 'w' ? row.black : row.white;
  if (losses <= wins) return null;
  return {
    kind: 'database-losses',
    san: row.san,
    uci: row.uci,
    total,
    wins,
    draws: row.draws,
    losses,
  };
}

export async function savePrepStopFrontier(
  rep: Repertoire,
  path: Edge[],
  currentFen: NormFen,
  reason = 'User marked this position as not sure.'
): Promise<FrontierCandidate | null> {
  const lastOpponent = [...path].reverse().find(edge => edge.mover !== rep.color && edge.childFen === currentFen);
  if (!lastOpponent) return null;
  const now = new Date().toISOString();
  const throughOpponent = path.slice(0, path.findIndex(edge => edge.id === lastOpponent.id) + 1);
  const candidate: FrontierCandidate = {
    id: frontierId(rep.id, lastOpponent.parentFen, lastOpponent.uci),
    repertoireId: rep.id,
    parentFen: lastOpponent.parentFen,
    childFen: lastOpponent.childFen,
    san: lastOpponent.san,
    uci: lastOpponent.uci,
    mover: lastOpponent.mover,
    path: throughOpponent.map(edge => ({
      fromFen: edge.parentFen,
      toFen: edge.childFen,
      san: edge.san,
      uci: edge.uci,
      mover: edge.mover,
      popularityFraction: edge.mover === rep.color ? 1 : 0.01,
      edgeId: edge.id,
    })),
    weight: 0,
    games: 0,
    popularityFraction: 0,
    source: 'stored',
    status: 'open',
    lastReason: reason,
    createdAt: now,
    updatedAt: now,
  };
  await putFrontiers([candidate]);
  return candidate;
}

export async function pickOpponentMoves(fen: NormFen, signal?: AbortSignal, trace?: GenerationTrace): Promise<OpponentMove[]> {
  const depth = TUNING.engineDepthLineGen;
  let resp: LichessExplorerResponse;
  traceStep(trace, `Opponent move picker: querying Lichess Explorer at ${fen}`);
  try {
    resp = await fetchExplorer(fen, { source: 'lichess' }, signal);
  } catch (e) {
    if (e instanceof LichessAuthError) {
      traceStep(trace, `Opponent move picker: Lichess auth error, not falling back: ${describeError(e)}`);
      throw e;
    }
    traceStep(trace, `Opponent move picker: Explorer failed, falling back to Stockfish: ${describeError(e)}`);
    return opponentMovesFromStockfish(fen, signal, trace, depth);
  }
  const total = resp.white + resp.draws + resp.black;
  traceStep(trace, `Opponent move picker: Explorer total games=${total}, candidate moves=${resp.moves.length}`);
  if (total === 0) {
    traceStep(trace, 'Opponent move picker: Explorer has zero games, falling back to Stockfish.');
    return opponentMovesFromStockfish(fen, signal, trace, depth);
  }

  const engine = await fetchLocalEval(fen, TUNING.cloudEvalMultiPv, depth, signal);
  return opponentMovesFromExplorer(fen, resp, total, engine, trace);
}

async function opponentMovesFromStockfish(fen: NormFen, signal?: AbortSignal, trace?: GenerationTrace, depth: number = TUNING.engineDepthLineGen): Promise<OpponentMove[]> {
  traceStep(trace, `Stockfish fallback: requesting ${TUNING.cloudEvalMultiPv} PVs at ${fen}`);
  const engine = await fetchLocalEval(fen, TUNING.cloudEvalMultiPv, depth, signal);
  if (!engine || engine.pvs.length === 0) {
    traceStep(trace, 'Stockfish fallback: no engine PVs returned.');
    return [];
  }
  traceStep(trace, `Stockfish fallback: engine returned ${engine.pvs.length} PVs at depth ${engine.depth ?? 'unknown'}.`);

  const mover = turnAt(fen);
  const bestCp = pvCpForColor(engine.pvs[0], mover);
  const seen = new Set<string>();
  const moves: OpponentMove[] = [];

  for (const pv of engine.pvs) {
    const bestUci = pv.moves.split(' ')[0];
    if (!bestUci || seen.has(bestUci)) continue;
    seen.add(bestUci);

    const applied = applyMove(fen, uciToObj(bestUci));
    if (!applied) {
      traceStep(trace, `Stockfish fallback: PV first move ${bestUci} could not be applied.`);
      continue;
    }

    const cp = pvCpForColor(pv, mover);
    const isMistake = bestCp !== null && cp !== null && bestCp - cp >= TUNING.mistakeThresholdPawn * 100;
    moves.push({
      san: applied.san,
      uci: applied.uci,
      popularityFraction: 1 / (moves.length + 1),
      isMistake,
    });
    traceStep(trace, `Stockfish fallback: accepted PV ${moves.length}: ${applied.san} (${applied.uci}), cpForMover=${cp ?? 'unknown'}, syntheticPopularity=${(1 / moves.length).toFixed(3)}`);
  }

  traceStep(trace, `Stockfish fallback: produced ${moves.length} opponent moves.`);
  return moves;
}

function opponentMovesFromExplorer(
  fen: NormFen,
  resp: LichessExplorerResponse,
  total: number,
  engine: CloudEvalResponse | null,
  trace?: GenerationTrace
): OpponentMove[] {
  const mover = turnAt(fen);
  const bestCp = engine && engine.pvs.length > 0 ? pvCpForColor(engine.pvs[0], mover) : null;
  const out: OpponentMove[] = [];
  let skippedLowPopularity = 0;
  for (const m of resp.moves) {
    const games = m.white + m.draws + m.black;
    const frac = games / total;
    if (frac < TUNING.opponentPopularityFraction) {
      skippedLowPopularity++;
      continue;
    }
    let isMistake = false;
    if (engine && bestCp !== null) {
      const pv = findPvForMove(engine, m.uci);
      const cp = pv ? pvCpForColor(pv, mover) : null;
      if (cp !== null && bestCp - cp >= TUNING.mistakeThresholdPawn * 100) isMistake = true;
    }
    out.push({ san: m.san, uci: m.uci, popularityFraction: frac, isMistake });
    traceStep(trace, `Opponent move picker: accepted Explorer move ${m.san} (${m.uci}), games=${games}, popularity=${frac.toFixed(3)}, isMistake=${isMistake}`);
  }
  traceStep(trace, `Opponent move picker: Explorer produced ${out.length} usable moves; skipped ${skippedLowPopularity} below ${(TUNING.opponentPopularityFraction * 100).toFixed(1)}%.`);
  return out;
}

// ---------- Find the priority frontier ----------

// A frontier is an opponent move, reachable through the user's stored prep, whose resulting
// position does not yet have a stored user response.
//
// We rank frontier moves by overall likelihood from the repertoire root. Once a frontier is
// selected, continuation inside the generated line uses local popularity for opponent replies.
//
// Search is bounded to keep things tractable.

export interface FrontierResult {
  fen: NormFen;
  cumulativeProbability: number;
  candidateId?: string;
  // The path of edges/moves leading to this frontier. Each step is either a stored edge or a
  // proposed implicit opponent move (still represented as SAN/UCI but `edgeId` is null).
  path: PathStep[];
  // Diagnostic only: which branch of findTopFrontier produced this result.
  // Surfaced in the UI's "Selection details" panel; never used for selection.
  reason?: 'frontier-index' | 'fallback-search';
}

export interface PathStep {
  fromFen: NormFen;
  toFen: NormFen;
  san: string;
  uci: string;
  mover: Color;
  edge: Edge | null; // null == implicit opponent move not yet in repertoire
  popularityFraction: number; // 1.0 for user moves; explorer fraction for opponent moves
  source?: FrontierSource;
}

export interface FrontierScope {
  key: string;
  openingKey: string | null;
  openingName: string | null;
  rootFen: NormFen;
  startFen: NormFen;
}

interface FrontierSearchLimits {
  clearFirst: boolean;
  maxNodes: number;
  maxExplorerCalls: number;
  stopAfterFrontiers?: number;
  reason: string;
}

function rootScope(rep: Repertoire): FrontierScope {
  return {
    key: 'root',
    openingKey: null,
    openingName: null,
    rootFen: rep.rootFen,
    startFen: rep.rootFen,
  };
}

function scopeFromStart(rep: Repertoire, openingScope: GenerationOpeningScope | null, start: GenerationStart): FrontierScope {
  if (!openingScope) return rootScope(rep);
  return {
    key: `${rep.color}:${openingScope.key}:${rep.rootFen}:${start.startFen}`,
    openingKey: openingScope.key,
    openingName: openingScope.name,
    rootFen: rep.rootFen,
    startFen: start.startFen,
  };
}

// Public helper: compute the same scope key that scopeFromStart would, given just the
// inputs the UI has on hand (no async DB walk needed). Used by the ready-line cache so
// that build/lookup keys stay in sync with the generator's internal scoping.
export function computeScopeKey(rep: Repertoire, openingScope: GenerationOpeningScope | null): string | null {
  const scope = scopeFromOpening(rep, openingScope);
  return scope ? scope.key : null;
}

// Public helper: build the full FrontierScope synchronously from the same
// inputs the UI has on hand. Used by the scoped-frontier views in TrainMode
// so `frontierInScope` (which needs `startFen` for the path check, not just
// the scope key) can be applied client-side. Returns null when the
// openingScope's SAN moves don't apply cleanly from STARTING_FEN_NORM —
// caller should treat that as no scope.
export function scopeFromOpening(rep: Repertoire, openingScope: GenerationOpeningScope | null): FrontierScope | null {
  if (!openingScope) return rootScope(rep);
  let startFen: NormFen = STARTING_FEN_NORM;
  for (const move of openingScope.moves) {
    const r = applyMove(startFen, move);
    if (!r) return null;
    startFen = r.fen;
  }
  return {
    key: `${rep.color}:${openingScope.key}:${rep.rootFen}:${startFen}`,
    openingKey: openingScope.key,
    openingName: openingScope.name,
    rootFen: rep.rootFen,
    startFen,
  };
}

function scopedFrontierId(rep: Repertoire, frontier: Pick<DiscoveredFrontier, 'parentFen' | 'uci'>, scope: FrontierScope): string {
  return `${scope.key}::${frontierId(rep.id, frontier.parentFen, frontier.uci)}`;
}

// A frontier is in scope iff:
//   1. its persisted scopeKey matches the active scope's key, AND
//   2. its position is at-or-downstream-of scope.startFen.
//
// Condition (2) catches a class of bugs where ancestor frontiers (positions on
// the path leading TO scope.startFen) were stamped with the scope's key at
// discovery time and then surfaced as candidates by selection. Example: with
// scope = Italian Game (startFen = post-3.Bc4), the frontier "Nc6 (b8c6)" sits
// at the position after 2...Nc6 — one ply BEFORE 3.Bc4 was played. Selecting it
// would extend the line from a position upstream of the Italian, freeing the
// engine to pick Bb5 (Ruy Lopez) instead of Bc4 (Italian). The scope-leak
// assertion at line-creation time catches and rejects this, but the cleaner fix
// is to never offer the candidate in the first place.
//
// "At-or-downstream-of scope.startFen" means scope.startFen appears somewhere in
// the chain rep.rootFen → frontier.parentFen (i.e., as a step.toFen in the
// frontier's path), or the frontier's parentFen IS scope.startFen (an OTM-F
// representing an unanswered immediate reply at the scope endpoint). When the
// scope is the root (no opening filter), startFen === rootFen and every
// frontier passes by definition.
export function frontierInScope(frontier: FrontierCandidate, scope: FrontierScope): boolean {
  if ((frontier.scopeKey ?? 'root') !== scope.key) return false;
  if (scope.startFen === scope.rootFen) return true;
  if (frontier.parentFen === scope.startFen) return true;
  return frontier.path.some(step => step.toFen === scope.startFen);
}

function frontierStatusCounts(frontiers: FrontierCandidate[]): Record<'open' | 'answered' | 'blocked' | 'stale', number> {
  return {
    open: frontiers.filter(frontier => frontier.status === 'open').length,
    answered: frontiers.filter(frontier => frontier.status === 'answered').length,
    blocked: frontiers.filter(frontier => frontier.status === 'blocked').length,
    stale: frontiers.filter(frontier => frontier.status === 'stale').length,
  };
}

// Three-phase algorithm:
//   Phase 1 — pure in-memory DFS through stored edges. No Lichess calls, no pruning.
//             Collects type-1 frontiers (your turn, no stored move) and every
//             opponent-to-move position for phase 2.
//   Phase 2 — parallel Lichess queries at all opponent positions. Discovers type-2
//             frontiers (unstored popular moves above the popularity threshold) and
//             scores them by game count.
//   Phase 3 — parallel Lichess queries at type-1 frontier FENs to score them by total
//             games in the database. Pick the frontier with the most games.
//
// Ranking: frontiers are sorted purely by `games` (total Lichess games at the
// frontier position). `weight` (∏ popularityFraction along the discovery path)
// is kept on each candidate for diagnostic display, but is NOT used to pick the
// winner. Past bug: weight was the primary sort key, but stored-edge DFS paths
// bypassed popularityFraction multiplication, so deep stored frontiers got
// weight≈1.0 and outranked broad shallow frontiers whose weight correctly
// decayed. Ranking by games sidesteps that and matches the user's mental model:
// "which unanswered position will the most real opponents actually reach me in".
// Do not re-introduce weight into selection. See docs/line-selection.md.
export async function findTopFrontier(
  rep: Repertoire,
  signal?: AbortSignal,
  trace?: GenerationTrace,
  start?: GenerationStart,
  scope: FrontierScope = rootScope(rep),
  allowBoundedFallback = true
): Promise<FrontierResult | null> {
  const [allFrontiers, storedEdges, readyLineQueueSize] = await Promise.all([
    getFrontiersForRepertoire(rep.id),
    getEdgesForRepertoire(rep.id),
    countReadyLines(rep.id, scope.key),
  ]);
  const scopedFrontiers = allFrontiers.filter(frontier => frontierInScope(frontier, scope));
  const counts = frontierStatusCounts(scopedFrontiers);
  const queuedRaw = await getOpenFrontiers(rep.id, scope.key);
  const queued = queuedRaw.filter(frontier => frontierInScope(frontier, scope));
  const filteredAncestorCount = queuedRaw.length - queued.length;
  traceStep(trace, `Frontier index stats: scope=${scope.key}, storedEdges=${storedEdges.length}, totalKnown=${scopedFrontiers.length}, open=${counts.open}, generatedLineQueueSize=${readyLineQueueSize}, answered=${counts.answered}, blocked=${counts.blocked}, stale=${counts.stale}.`);
  if (filteredAncestorCount > 0) {
    traceStep(trace, `Frontier index: filtered ${filteredAncestorCount} ancestor candidate(s) whose path does not pass through scope.startFen=${scope.startFen}. These were stamped with this scope's key at discovery time but sit upstream of the scope endpoint.`);
  }
  for (const candidate of randomizeNewCardIntroOrder(queued)) {
    const hydrated = await hydrateFrontierCandidate(rep, candidate, trace);
    if (hydrated) {
      traceStep(trace, `Line source: frontier-index; selected ${candidate.san} (${candidate.uci}) because it is an open candidate in the top games pool; games=${candidate.games}, weight=${candidate.weight.toFixed(5)} (display only), childFen=${candidate.childFen}.`);
      hydrated.reason = 'frontier-index';
      return hydrated;
    }
  }
  if (queued.length > 0) {
    traceStep(trace, 'Frontier index: no indexed candidates were usable.');
  }
  if (!allowBoundedFallback) return null;
  traceStep(trace, `Line source: fallback-search; bounded miss for scope=${scope.key}.`);
  const fallback = await findTopUnansweredOpponentMove(rep, signal, trace, start, scope, {
    clearFirst: false,
    maxNodes: TUNING.maxFrontierFallbackNodes,
    maxExplorerCalls: TUNING.maxFrontierFallbackExplorerCalls,
    reason: 'fallback-search',
  });
  if (fallback) fallback.reason = 'fallback-search';
  return fallback;
}

export async function rebuildFrontierQueue(
  rep: Repertoire,
  signal?: AbortSignal,
  trace?: GenerationTrace,
  openingScope?: GenerationOpeningScope | null
): Promise<FrontierResult | null> {
  const start = await prepareGenerationStart(rep, openingScope ?? null, trace);
  const scope = scopeFromStart(rep, openingScope ?? null, start);
  traceStep(trace, `Frontier refill start: reason=full-rebuild, scope=${scope.key}; preserving blocked/rejected frontier state.`);
  return findTopUnansweredOpponentMove(rep, signal, trace, start, scope, {
    clearFirst: false,
    maxNodes: TUNING.maxFrontierRebuildNodes,
    maxExplorerCalls: TUNING.maxFrontierExplorerCalls,
    reason: 'full-rebuild',
  });
}

async function hydrateFrontierCandidate(rep: Repertoire, candidate: FrontierCandidate, trace?: GenerationTrace): Promise<FrontierResult | null> {
  if (!frontierPathMatchesRoot(rep.rootFen, candidate)) {
    traceStep(trace, `Frontier index: candidate ${candidate.san} (${candidate.uci}) starts from a stale root; marking blocked.`);
    await markFrontierBlocked(candidate.id, 'This queued frontier was built from an older repertoire root.');
    return null;
  }

  const childEdges = await getEdgesFromParent(rep.id, candidate.childFen);
  if (childEdges.some(edge => edge.mover === rep.color && !edge.isScaffold)) {
    traceStep(trace, `Frontier index: candidate ${candidate.san} (${candidate.uci}) already has a user reply; marking answered.`);
    await markFrontierAnswered(candidate.id, 'A trainable user reply already exists at this frontier.');
    return null;
  }

  const path: PathStep[] = [];
  for (const step of candidate.path) {
    const edge = await getEdge(rep.id, step.fromFen, step.toFen);
    path.push({
      fromFen: step.fromFen,
      toFen: step.toFen,
      san: step.san,
      uci: step.uci,
      mover: step.mover,
      edge: edge ?? null,
      popularityFraction: step.popularityFraction,
      source: candidate.source,
    });
  }
  return {
    fen: candidate.childFen,
    cumulativeProbability: candidate.weight,
    candidateId: candidate.id,
    path,
  };
}

function frontierPathMatchesRoot(rootFen: NormFen, candidate: FrontierCandidate): boolean {
  if (candidate.path.length === 0) return candidate.childFen === rootFen;
  let cursorFen = rootFen;
  for (const step of candidate.path) {
    if (step.fromFen !== cursorFen) return false;
    cursorFen = step.toFen;
  }
  return cursorFen === candidate.childFen;
}

export async function findTopFrontierLegacy(rep: Repertoire, signal?: AbortSignal): Promise<FrontierResult | null> {
  const all = await getEdgesForRepertoire(rep.id);
  const byParent = new Map<NormFen, Edge[]>();
  for (const e of all) {
    let arr = byParent.get(e.parentFen);
    if (!arr) { arr = []; byParent.set(e.parentFen, arr); }
    arr.push(e);
  }

  // ── Phase 1: in-memory DFS ───────────────────────────────────────────────
  type Candidate = { fen: NormFen; path: PathStep[]; games: number };
  const type1: Candidate[] = [];
  const opponentPositions: { fen: NormFen; path: PathStep[]; storedEdges: Edge[] }[] = [];

  const dfsStack: { fen: NormFen; path: PathStep[] }[] = [{ fen: rep.rootFen, path: [] }];
  const visited = new Set<NormFen>();

  while (dfsStack.length) {
    if (signal?.aborted) return null;
    const { fen, path } = dfsStack.pop()!;
    if (visited.has(fen)) continue;
    visited.add(fen);

    const turn = turnAt(fen);
    const stored = byParent.get(fen) ?? [];
    if (chessFromFen(fen).isGameOver()) continue;

    if (turn === rep.color) {
      if (stored.length === 0) {
        type1.push({ fen, path, games: 0 });
      } else {
        for (const e of stored) {
          if (e.mover !== rep.color) continue;
          dfsStack.push({
            fen: e.childFen,
            path: [...path, { fromFen: e.parentFen, toFen: e.childFen, san: e.san, uci: e.uci, mover: e.mover, edge: e, popularityFraction: 1 }],
          });
        }
      }
    } else {
      opponentPositions.push({ fen, path, storedEdges: stored });
      for (const e of stored) {
        dfsStack.push({
          fen: e.childFen,
          path: [...path, { fromFen: e.parentFen, toFen: e.childFen, san: e.san, uci: e.uci, mover: e.mover, edge: e, popularityFraction: 0 }],
        });
      }
    }
  }

  // ── Phase 2: parallel Lichess queries at opponent positions ───────────────
  // Discovers type-2 frontiers (unstored popular moves) and their game counts.
  const type2: Candidate[] = [];
  if (opponentPositions.length > 0) {
    const explorerResults = await Promise.all(
      opponentPositions.map(async ({ fen: oppFen, path: oppPath, storedEdges }) => {
        try {
          const data = await fetchExplorer(oppFen, { source: 'lichess' }, signal);
          return { oppFen, oppPath, storedEdges, data };
        } catch (e) {
          if (e instanceof LichessAuthError) throw e;
          return { oppFen, oppPath, storedEdges, data: null };
        }
      })
    );

    for (const { oppFen, oppPath, storedEdges, data } of explorerResults) {
      if (!data) continue;
      const storedUcis = new Set(storedEdges.map(e => e.uci));
      const total = data.white + data.draws + data.black;
      if (total === 0) continue;
      for (const m of data.moves) {
        const frac = (m.white + m.draws + m.black) / total;
        if (frac < TUNING.opponentPopularityFraction) continue;
        if (storedUcis.has(m.uci)) continue; // already handled
        const result = applyMove(oppFen, m.san);
        if (!result) continue;
        type2.push({
          fen: result.fen,
          path: [...oppPath, {
            fromFen: oppFen, toFen: result.fen, san: m.san, uci: m.uci,
            mover: turnAt(oppFen), edge: null, popularityFraction: frac,
          }],
          games: m.white + m.draws + m.black,
        });
      }
    }
  }

  // ── Phase 3: score type-1 frontiers by Lichess game count ────────────────
  const scoredType1 = await Promise.all(
    type1.map(async (c) => {
      try {
        const data = await fetchExplorer(c.fen, { source: 'lichess' }, signal);
        return { ...c, games: data ? data.white + data.draws + data.black : 0 };
      } catch (e) {
        if (e instanceof LichessAuthError) throw e;
        return { ...c, games: 0 };
      }
    })
  );

  // Deduplicate by FEN across both types, keeping highest game count.
  const byFen = new Map<NormFen, Candidate>();
  for (const c of [...scoredType1, ...type2]) {
    const existing = byFen.get(c.fen);
    if (!existing || c.games > existing.games) byFen.set(c.fen, c);
  }

  const allCandidates = Array.from(byFen.values());
  if (allCandidates.length === 0) return null;
  allCandidates.sort((a, b) => b.games - a.games);
  const winner = allCandidates[0];
  return { fen: winner.fen, cumulativeProbability: winner.games, path: winner.path };
}

interface TraversalOpponentMove {
  san: string;
  uci: string;
  games: number;
  popularityFraction: number;
  storedEdge: Edge | null;
  source: FrontierSource;
}

interface DiscoveredFrontier {
  fen: NormFen;
  path: PathStep[];
  games: number;
  weight: number;
  parentFen: NormFen;
  san: string;
  uci: string;
  mover: Color;
  popularityFraction: number;
  source: FrontierSource;
}

function frontierCandidateFromDiscovery(rep: Repertoire, frontier: DiscoveredFrontier, scope: FrontierScope): FrontierCandidate {
  const now = new Date().toISOString();
  return {
    id: scopedFrontierId(rep, frontier, scope),
    repertoireId: rep.id,
    color: rep.color,
    openingKey: scope.openingKey,
    openingName: scope.openingName,
    scopeKey: scope.key,
    rootFen: scope.rootFen,
    startFen: scope.startFen,
    parentFen: frontier.parentFen,
    childFen: frontier.fen,
    san: frontier.san,
    uci: frontier.uci,
    mover: frontier.mover,
    path: frontier.path.map(step => ({
      fromFen: step.fromFen,
      toFen: step.toFen,
      san: step.san,
      uci: step.uci,
      mover: step.mover,
      popularityFraction: step.popularityFraction,
      edgeId: step.edge?.id ?? null,
    })),
    weight: frontier.weight,
    games: frontier.games,
    popularityFraction: frontier.popularityFraction,
    source: frontier.source,
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
}

async function findTopUnansweredOpponentMove(
  rep: Repertoire,
  signal?: AbortSignal,
  trace?: GenerationTrace,
  start?: GenerationStart,
  scope: FrontierScope = rootScope(rep),
  limits: FrontierSearchLimits = {
    clearFirst: false,
    maxNodes: TUNING.maxFrontierRebuildNodes,
    maxExplorerCalls: TUNING.maxFrontierExplorerCalls,
    reason: 'frontier-index',
  }
): Promise<FrontierResult | null> {
  if (limits.clearFirst) await clearFrontiersForRepertoire(rep.id, scope.key);
  const all = await getEdgesForRepertoire(rep.id);
  const byParent = new Map<NormFen, Edge[]>();
  for (const edge of all) {
    const arr = byParent.get(edge.parentFen) ?? [];
    arr.push(edge);
    byParent.set(edge.parentFen, arr);
  }

  const frontiers: DiscoveredFrontier[] = [];
  const startPath = start?.path.map(edge => ({
    fromFen: edge.parentFen,
    toFen: edge.childFen,
    san: edge.san,
    uci: edge.uci,
    mover: edge.mover,
    edge,
    popularityFraction: 1,
    source: 'stored' as FrontierSource,
  })) ?? [];
  const stack: Array<{ fen: NormFen; path: PathStep[]; weight: number }> = [{ fen: start?.startFen ?? rep.rootFen, path: startPath, weight: 1 }];
  const visited = new Set<string>();
  let explorerCalls = 0;
  let stopReason = 'exhausted';
  traceStep(trace, `Frontier refill search: reason=${limits.reason}, scope=${scope.key}, repertoire="${rep.name}", color=${rep.color}, root=${rep.rootFen}, start=${start?.startFen ?? rep.rootFen}, storedEdges=${all.length}, maxNodes=${limits.maxNodes}, maxExplorerCalls=${limits.maxExplorerCalls}`);

  while (stack.length) {
    if (signal?.aborted) {
      traceStep(trace, 'Frontier search: aborted.');
      return null;
    }
    const { fen, path, weight } = stack.pop()!;
    const visitKey = `${fen}|${path.length}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    if (visited.size > limits.maxNodes) {
      stopReason = 'node-limit';
      break;
    }
    if (path.length >= TUNING.maxFrontierPlies) {
      traceStep(trace, `Frontier search: max depth reached at ply ${path.length}, fen=${fen}`);
      continue;
    }
    if (chessFromFen(fen).isGameOver()) {
      traceStep(trace, `Frontier search: game-over position skipped at ply ${path.length}, fen=${fen}`);
      continue;
    }

    const stored = byParent.get(fen) ?? [];
    if (turnAt(fen) === rep.color) {
      const userEdges = stored.filter(edge => edge.mover === rep.color);
      if (userEdges.length === 0) {
        // A frontier is created by the opponent move that led to this position.
      }
      for (const edge of stored) {
        if (edge.mover !== rep.color) continue;
        stack.push({
          fen: edge.childFen,
          weight,
          path: [...path, {
            fromFen: edge.parentFen,
            toFen: edge.childFen,
            san: edge.san,
            uci: edge.uci,
            mover: edge.mover,
            edge,
            popularityFraction: 1,
            source: 'stored',
          }],
        });
      }
      continue;
    }

    if (explorerCalls >= limits.maxExplorerCalls) {
      stopReason = 'explorer-call-limit';
      break;
    }
    explorerCalls++;
    const opponentMoves = await getOpponentMovesForFrontier(fen, stored, signal, trace);
    for (const move of opponentMoves) {
      const result = applyMove(fen, uciToObj(move.uci)) ?? applyMove(fen, move.san);
      if (!result) {
        traceStep(trace, `Frontier search: could not apply opponent move ${move.san} (${move.uci}) at ${fen}`);
        continue;
      }
      const nextWeight = weight * (move.popularityFraction || 0.01);
      if (nextWeight < 0.001) {
        continue;
      }
      const nextPath = [...path, {
        fromFen: fen,
        toFen: result.fen,
        san: result.san,
        uci: result.uci,
        mover: result.mover,
        edge: move.storedEdge,
        popularityFraction: move.popularityFraction,
        source: move.source,
      }];

      const childStored = byParent.get(result.fen) ?? [];
      const hasUserReply = childStored.some(edge => edge.mover === rep.color && !edge.isScaffold);
      if (!hasUserReply) {
        frontiers.push({
          fen: result.fen,
          path: nextPath,
          games: move.games,
          weight: nextWeight,
          parentFen: fen,
          san: result.san,
          uci: result.uci,
          mover: result.mover,
          popularityFraction: move.popularityFraction,
          source: move.source,
        });
        if (limits.stopAfterFrontiers !== undefined && frontiers.length >= limits.stopAfterFrontiers) {
          stopReason = 'frontier-cap-reached';
          stack.length = 0;
          break;
        }
      } else {
        stack.push({ fen: result.fen, path: nextPath, weight: nextWeight });
      }
    }
  }

  if (frontiers.length === 0) {
    traceStep(trace, `Frontier refill stop: reason=${stopReason}, scope=${scope.key}, indexSize=0, nodesInspected=${visited.size}, explorerCalls=${explorerCalls}.`);
    return null;
  }
  // Rank by raw `games` only (response volume at the frontier). `weight` stays
  // on each candidate for display/debug but does NOT influence selection.
  frontiers.sort((a, b) => b.games - a.games);
  const candidateRows = frontiers.map(frontier => frontierCandidateFromDiscovery(rep, frontier, scope));
  const discoveredById = new Map(candidateRows.map((row, idx) => [row.id, frontiers[idx]]));
  await putFrontiers(candidateRows);
  traceStep(trace, `Frontier refill stop: reason=${stopReason}, scope=${scope.key}, indexSize=${frontiers.length}, nodesInspected=${visited.size}, explorerCalls=${explorerCalls}.`);
  const openRows = await getOpenFrontiers(rep.id, scope.key);
  const eligibleRows = openRows.filter(row => discoveredById.has(row.id));
  if (eligibleRows.length === 0) {
    traceStep(trace, `Frontier index: discovered ${frontiers.length} candidate(s), but none are open after preserving blocked/rejected state.`);
    return null;
  }
  const winnerRow = randomizeNewCardIntroOrder(eligibleRows)[0];
  const winner = discoveredById.get(winnerRow.id)!;
  traceStep(trace, `Frontier index: selected frontier from rebuilt index because it is in the top games pool; games=${winner.games}, weight=${winner.weight.toFixed(5)} (display only), fen=${winner.fen}, pathLength=${winner.path.length}`);
  return { fen: winner.fen, cumulativeProbability: winner.weight, candidateId: winnerRow.id, path: winner.path };
}

// Picks the top-`games` candidates and shuffles within the leading "close" group
// so the user doesn't keep getting the same exact frontier when several are
// roughly equally popular. Ranking and pool-membership use `games` ONLY.
function randomizeNewCardIntroOrder<T extends { weight: number; games: number }>(candidates: T[]): T[] {
  if (candidates.length <= 1) return candidates;
  const sorted = [...candidates].sort((a, b) => b.games - a.games);
  const best = sorted[0];
  const topPool = sorted.filter(candidate => {
    if (best.games === 0) return candidate.games === 0;
    return candidate.games >= best.games * 0.5;
  }).slice(0, 5);
  const rest = sorted.filter(candidate => !topPool.includes(candidate));
  return [...shuffle(topPool), ...rest];
}

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function getOpponentMovesForFrontier(
  fen: NormFen,
  stored: Edge[],
  signal?: AbortSignal,
  trace?: GenerationTrace
): Promise<TraversalOpponentMove[]> {
  const mover = turnAt(fen);
  const storedByUci = new Map(stored.filter(edge => edge.mover === mover).map(edge => [edge.uci, edge]));
  let data: LichessExplorerResponse | null = null;
  traceStep(trace, `Frontier opponent moves: querying Explorer at ${fen}; stored opponent edges=${storedByUci.size}`);
  try {
    data = await fetchExplorer(fen, { source: 'lichess' }, signal);
  } catch (e) {
    if (e instanceof LichessAuthError) {
      traceStep(trace, `Frontier opponent moves: Lichess auth error, not falling back: ${describeError(e)}`);
      throw e;
    }
    traceStep(trace, `Frontier opponent moves: Explorer failed, will use stored moves or Stockfish if needed: ${describeError(e)}`);
  }

  const total = data ? data.white + data.draws + data.black : 0;
  const moves: TraversalOpponentMove[] = [];
  let skippedLowPopularity = 0;
  if (data && total > 0) {
    traceStep(trace, `Frontier opponent moves: Explorer total games=${total}, candidate moves=${data.moves.length}`);
    for (const m of data.moves) {
      const games = m.white + m.draws + m.black;
      const popularityFraction = games / total;
      const storedEdge = storedByUci.get(m.uci) ?? null;
      if (!storedEdge && popularityFraction < TUNING.opponentPopularityFraction) {
        skippedLowPopularity++;
        continue;
      }
      moves.push({ san: m.san, uci: m.uci, games, popularityFraction, storedEdge, source: 'explorer' });
      storedByUci.delete(m.uci);
      traceStep(trace, `Frontier opponent moves: accepted ${m.san} (${m.uci}), games=${games}, popularity=${popularityFraction.toFixed(3)}, stored=${Boolean(storedEdge)}`);
    }
    traceStep(trace, `Frontier opponent moves: skipped ${skippedLowPopularity} Explorer moves below threshold.`);
  } else if (data) {
    traceStep(trace, `Frontier opponent moves: Explorer returned zero total games with ${data.moves.length} move rows.`);
  }

  for (const edge of storedByUci.values()) {
    moves.push({ san: edge.san, uci: edge.uci, games: 0, popularityFraction: 0.01, storedEdge: edge, source: 'stored' });
    traceStep(trace, `Frontier opponent moves: keeping stored-only move ${edge.san} (${edge.uci}) with fallback popularity 0.010.`);
  }

  if (moves.length === 0) {
    traceStep(trace, 'Frontier opponent moves: no Explorer or stored moves produced; asking Stockfish.');
    const stockfishMoves = await opponentMovesFromStockfish(fen, signal, trace);
    for (const move of stockfishMoves) {
      moves.push({
        san: move.san,
        uci: move.uci,
        games: 0,
        popularityFraction: move.popularityFraction,
        storedEdge: null,
        source: 'stockfish',
      });
    }
  }

  moves.sort((a, b) => b.popularityFraction - a.popularityFraction);
  return moves;
}

// ---------- Generate a learn-line ----------

// From a frontier (where it's your turn and you have no stored move), generate a sequence
// of plies: 5 of YOUR moves, with intervening top-popular opponent moves automatically added
// to the repertoire. Returns the sequence of newly-created OR newly-touched edges representing
// the line for the learn phase.
//
// Side effect: persists all path-leading edges (from rep root → frontier) and all generated
// edges (frontier → end of line) into the repertoire.
// Where a GeneratedLine's frontier was sourced from. Used for the in-UI
// "Selection details" panel and the Copy line report — not for any selection
// logic. Cache hits set this to 'cache-hit' on rehydrate; fresh generation
// sets it based on which branch of the frontier finder won.
export type LineSelectionReason =
  | 'frontier-index'        // hit on the stored frontier index for this scope
  | 'fallback-search'       // bounded re-search after the index missed
  | 'stockfish-fallback'    // no usable frontier at all; engine drove the line
  | 'cache-hit'             // served from the persistent ReadyLine cache
  | 'continue';             // continueLearnLine (resumed a partial line)

export interface GeneratedLine {
  // The full sequence of edges from rep root → end of generated line, in order.
  fullPath: Edge[];
  // The subset of edges newly added during generation (used for the learn-test SRS scope).
  newEdges: Edge[];
  // Index into fullPath where the generation began (i.e., the frontier).
  generationStartIndex: number;
  // Local frontier queue row that seeded this line, when available.
  frontierId?: string;
  frontierFen?: NormFen;
  // Diagnostic only — surfaces in the Selection details panel. Never used by
  // any selection logic. See docs/line-selection.md.
  selectionReason?: LineSelectionReason;
}

export interface GenerationOpeningScope {
  key: string;
  name: string;
  moves: string[];
}

interface GenerationStart {
  startFen: NormFen;
  path: Edge[];
}

interface ActiveSourceLine {
  line: PlayerBookSourceLine;
  index: number;
  playerName: string;
}

async function prepareGenerationStart(rep: Repertoire, openingScope: GenerationOpeningScope | null, trace?: GenerationTrace): Promise<GenerationStart> {
  if (!openingScope) return { startFen: rep.rootFen, path: [] };

  let cursorFen: NormFen = STARTING_FEN_NORM;
  let rootPly: number | null = rep.rootFen === STARTING_FEN_NORM ? 0 : null;
  for (const [idx, move] of openingScope.moves.entries()) {
    const result = applyMove(cursorFen, move);
    if (!result) throw new Error(`${openingScope.name} has an invalid base move at ply ${idx + 1}: ${move}`);
    cursorFen = result.fen;
    if (rootPly === null && cursorFen === rep.rootFen) rootPly = idx + 1;
  }
  if (rootPly === null) {
    throw new Error(`${openingScope.name} cannot legally connect to ${rep.name}'s repertoire root.`);
  }

  const movesFromRoot = openingScope.moves.slice(rootPly);
  if (movesFromRoot.length > 0) {
    traceStep(trace, `Line generation: ensuring opening scope path for ${openingScope.name}: ${movesFromRoot.join(' ')}.`);
    await addMovesToRepertoire(rep, movesFromRoot, { scaffoldPlyCount: movesFromRoot.length });
  }

  const path: Edge[] = [];
  cursorFen = rep.rootFen;
  for (const move of movesFromRoot) {
    const result = applyMove(cursorFen, move);
    if (!result) throw new Error(`${openingScope.name} cannot play ${move} from ${cursorFen}.`);
    const edge = await getEdge(rep.id, cursorFen, result.fen);
    if (!edge) throw new Error(`${openingScope.name} scope edge was not stored for ${move}.`);
    path.push(edge);
    cursorFen = result.fen;
  }

  traceStep(trace, `Line generation: constrained to ${openingScope.name}; startFen=${cursorFen}; scopePath=${path.length}.`);
  return { startFen: cursorFen, path };
}

// One generation pass: walks the existing frontier, extends with picked user/opponent
// moves, persists everything to the repertoire DB. The new generateLearnLine wrapper
// (below) calls this up to TUNING.qualityGateMaxAttempts times and uses snapshot-diff
// cleanup to remove any edges/frontiers from rejected attempts.
export async function generateLearnLineOnce(
  rep: Repertoire,
  yourMoveBudget = 5,
  signal?: AbortSignal,
  trace?: GenerationTrace,
  openingScope?: GenerationOpeningScope | null
): Promise<GeneratedLine | null> {
  traceStep(trace, `Line generation: starting for repertoire="${rep.name}", color=${rep.color}, budget=${yourMoveBudget}, openingScope=${openingScope?.name ?? 'none'}.`);
  const generationStart = await prepareGenerationStart(rep, openingScope ?? null, trace);
  const scope = scopeFromStart(rep, openingScope ?? null, generationStart);
  const frontier = await findTopFrontier(rep, signal, trace, generationStart, scope, true);
  if (!frontier) {
    traceStep(trace, 'Line source: stockfish-fallback; no indexed or bounded frontier found.');
    const fallback = await generateStockfishFallbackLine(rep, yourMoveBudget, signal, trace, generationStart);
    if (fallback) fallback.selectionReason = 'stockfish-fallback';
    return fallback;
  }
  traceStep(trace, `Line generation: frontier ready at ${frontier.fen}; pathLength=${frontier.path.length}.`);
  const activeFrontierId = frontier.candidateId;
  const activeFrontierFen = frontier.fen;

  // Step 1: persist any implicit opponent edges along the path to the frontier.
  // These were "implicit" during traversal but should now exist as real edges so the
  // repertoire reflects what we trained.
  const fullPath: Edge[] = [];
  let cursorFen = rep.rootFen;
  for (const step of frontier.path) {
    if (step.fromFen !== cursorFen) {
      traceStep(trace, `Line generation: frontier path mismatch. expected=${cursorFen}, got=${step.fromFen}.`);
      throw new FrontierGenerationError('Frontier path no longer matches this repertoire root.', activeFrontierId);
    }
    if (step.edge) {
      traceStep(trace, `Line generation: path uses stored edge ${step.san} (${step.uci}).`);
      fullPath.push(step.edge);
    } else {
      traceStep(trace, `Line generation: persisting implicit opponent edge ${step.san} (${step.uci}) at ${cursorFen}.`);
      const r = await playMoveInRepertoire(rep.id, cursorFen, step.san);
      if (!r) {
        traceStep(trace, `Line generation: failed to persist implicit edge ${step.san} at ${cursorFen}.`);
        throw new FrontierGenerationError(`Could not persist frontier path move ${step.san} at ${cursorFen}.`, activeFrontierId);
      }
      fullPath.push(r.edge);
    }
    cursorFen = step.toFen;
  }

  // Step 2: from the frontier, generate up to `yourMoveBudget` of your moves with intervening
  // top-popular opponent moves.
  const newEdges: Edge[] = [];
  const generationStartIndex = fullPath.length;
  let yourMovesAdded = 0;
  let activeSourceLine: ActiveSourceLine | null = null;
  // Why the extension loop exited. Drives the post-loop length check: only
  // 'budget-reached' or 'game-over' are acceptable terminations for a published
  // line. Anything else means the loop bailed early and we'd be publishing a stub.
  let terminationReason: 'budget-reached' | 'game-over' | 'no-user-move' | 'no-opponent-move' | 'top-opponent-edge-missing' | 'aborted' = 'budget-reached';
  while (yourMovesAdded < yourMoveBudget) {
    if (signal?.aborted) { terminationReason = 'aborted'; break; }
    const turn = turnAt(cursorFen);
    traceStep(trace, `Line generation: extension loop at ${cursorFen}; turn=${turn}; yourMovesAdded=${yourMovesAdded}/${yourMoveBudget}.`);
    if (chessFromFen(cursorFen).isGameOver()) {
      traceStep(trace, 'Line generation: stopped because position is game-over.');
      terminationReason = 'game-over';
      break;
    }

    if (turn === rep.color) {
      const sourceLine = activeSourceLine;
      const sourceMove = sourceLine ? sourceMoveAt(cursorFen, sourceLine) : null;
      if (sourceLine && sourceMove) {
        traceStep(trace, `Line generation: trying source-line user move ${sourceMove.san} (${sourceMove.uci}).`);
        const played = await playSourceLineMove(rep, cursorFen, sourceMove.san, sourceLine, true);
        if (!played) {
          traceStep(trace, `Line generation: source-line user move ${sourceMove.san} could not be played; falling back to picker.`);
          activeSourceLine = null;
        } else {
          fullPath.push(played.edge);
          if (played.edgeCreated && isTrainableMove(played.edge, rep.color)) newEdges.push(played.edge);
          cursorFen = played.edge.childFen;
          sourceLine.index++;
          yourMovesAdded++;
          traceStep(trace, `Line generation: added source-line user move ${played.edge.san}; edgeCreated=${played.edgeCreated}.`);
          continue;
        }
      }

      traceStep(trace, `Line generation: picking user move at ${cursorFen}.`);
      let pick = (await pickYourMove(cursorFen, rep.color, signal, trace))
              ?? (await pickAnyDatabaseMove(cursorFen, rep.color, signal, trace));
      if (!pick) {
        pick = pickFirstLegalMove(cursorFen, trace);
      }
      if (!pick) {
        traceStep(trace, `Line generation: no legal user move available at ${cursorFen}.`);
        terminationReason = 'no-user-move';
        break;
      }
      traceStep(trace, `Line generation: picked user move ${pick.san} (${pick.uci}) from ${pick.source}.`);
      const played = await playPickedUserMove(rep, cursorFen, pick);
      if (!played) {
        traceStep(trace, `Line generation: could not play picked user move ${pick.san} at ${cursorFen}.`);
        terminationReason = 'no-user-move';
        break;
      }
      fullPath.push(played.edge);
      if (played.edgeCreated) newEdges.push(played.edge);
      cursorFen = played.edge.childFen;
      activeSourceLine = makeActiveSourceLine(pick);
      yourMovesAdded++;
      traceStep(trace, `Line generation: added user move ${played.edge.san}; edgeCreated=${played.edgeCreated}.`);
    } else {
      const sourceLine = activeSourceLine;
      const sourceMove = sourceLine ? sourceMoveAt(cursorFen, sourceLine) : null;
      if (sourceLine && sourceMove) {
        traceStep(trace, `Line generation: trying source-line opponent move ${sourceMove.san} (${sourceMove.uci}).`);
        const played = await playSourceLineMove(rep, cursorFen, sourceMove.san, sourceLine, false);
        if (played) {
          fullPath.push(played.edge);
          cursorFen = played.edge.childFen;
          sourceLine.index++;
          traceStep(trace, `Line generation: added source-line opponent move ${played.edge.san}; edgeCreated=${played.edgeCreated}.`);
          continue;
        }
        traceStep(trace, `Line generation: source-line opponent move ${sourceMove.san} could not be played; using opponent picker.`);
        activeSourceLine = null;
      }

      // Opponent move: pick the most-popular response. Also add ALL above-threshold opponent
      // moves to the repertoire as branches (so the user has scaffolding to face them in
      // future sessions), but only follow the top-popular one for THIS line.
      const opMoves = await pickOpponentMoves(cursorFen, signal, trace);
      if (opMoves.length === 0) {
        traceStep(trace, `Line generation: opponent picker returned zero moves at ${cursorFen}.`);
        terminationReason = 'no-opponent-move';
        break;
      }
      const sorted = [...opMoves].sort((a, b) => b.popularityFraction - a.popularityFraction);
      const top = sorted[0];
      traceStep(trace, `Line generation: top opponent move is ${top.san} (${top.uci}); adding ${sorted.length} opponent branches.`);
      // Add all branches.
      let topEdge: Edge | null = null;
      for (const om of sorted) {
        const existing = (await getEdgesFromParent(rep.id, cursorFen)).find(e => e.uci === om.uci);
        if (existing) {
          traceStep(trace, `Line generation: opponent branch already exists ${existing.san} (${existing.uci}).`);
          if (om === top) topEdge = existing;
          continue;
        }
        const r = await playMoveInRepertoire(rep.id, cursorFen, om.san);
        if (!r) {
          traceStep(trace, `Line generation: failed to add opponent branch ${om.san} (${om.uci}).`);
          continue;
        }
        if (om.isMistake) {
          await saveEdgeMistake(r.edge);
          r.edge.isMistake = true;
        }
        traceStep(trace, `Line generation: added opponent branch ${r.edge.san} (${r.edge.uci}); isMistake=${om.isMistake}.`);
        if (om === top) topEdge = r.edge;
      }
      if (!topEdge) {
        traceStep(trace, `Line generation: top opponent edge was not created/found for ${top.san} (${top.uci}).`);
        terminationReason = 'top-opponent-edge-missing';
        break;
      }
      fullPath.push(topEdge);
      cursorFen = topEdge.childFen;
    }
  }

  if (yourMovesAdded === 0) {
    traceStep(trace, 'Line generation: failed because zero user moves were added.');
    throw new FrontierGenerationError('Line generation could not add a user move from this frontier.', activeFrontierId);
  }
  // Strict length invariant: the line must reach the user's configured budget exactly,
  // unless the game ended naturally (mate, stalemate, threefold, fifty-move,
  // insufficient material — all covered by chess.js's isGameOver()). Anything else
  // means the loop bailed early on a real problem (no popular opponent reply, no
  // legal user move, etc.) and we'd be publishing a stub instead of a learnable line.
  if (yourMovesAdded < yourMoveBudget && terminationReason !== 'game-over') {
    const message = `Line generation produced ${yourMovesAdded} of ${yourMoveBudget} user moves (terminated: ${terminationReason}). Refusing to publish a stub line.`;
    traceStep(trace, `Line generation: ${message}`);
    throw new FrontierGenerationError(message, activeFrontierId);
  }
  if (activeFrontierId) {
    await markFrontierAnswered(activeFrontierId, 'Line generation added at least one user move from this frontier.');
    traceStep(trace, `Frontier index: marked ${activeFrontierId} answered.`);
  }
  const answeredCount = await markFrontiersAnsweredByChildFen(rep.id, activeFrontierFen, 'Line generation added a user move from this frontier position.');
  if (answeredCount > 0) {
    traceStep(trace, `Frontier index: marked ${answeredCount} candidate${answeredCount === 1 ? '' : 's'} answered for childFen=${activeFrontierFen}.`);
  }
  traceStep(trace, `Line generation: success. fullPath=${fullPath.length}, newEdges=${newEdges.length}, generationStartIndex=${generationStartIndex}, source=${frontier.reason ?? 'unknown'}.`);
  return { fullPath, newEdges, generationStartIndex, frontierId: activeFrontierId, frontierFen: activeFrontierFen, selectionReason: frontier.reason };
}

// Quality-gated wrapper around generateLearnLineOnce. Generates ONE line, then
// deep-evaluates its start and end FENs at TUNING.engineDepthGate and either
// returns the line on PASS or rejects it on FAIL.
//
// Single-attempt by design. The picker is deterministic per FEN ([docs/line-selection.md
// "We don't actually retry on FAIL because pickYourMove is deterministic"]), so a
// second attempt within the same run would reproduce the same line. The previous
// blocked-frontier workaround that altered retry behavior has been removed —
// rejections now surface as a failure report for the user to investigate.
//
// Before any work: ping local Stockfish to confirm the depth-sensitive eval path
// is live, and auto-clear any historical blocked frontiers from prior runs so
// the repertoire self-heals after this version transition.
export async function generateLearnLine(
  rep: Repertoire,
  yourMoveBudget = 5,
  signal?: AbortSignal,
  trace?: GenerationTrace,
  openingScope?: GenerationOpeningScope | null
): Promise<GeneratedLine | null> {
  // Local Stockfish health probe. Cheap (depth 6, starting position is cached after
  // first call) and converts the silent-degradation failure mode — every eval call
  // returns null mid-line and the line truncates — into a loud actionable error.
  const probe = await fetchLocalEval(STARTING_FEN_NORM, 1, 6, signal);
  if (!probe) {
    const msg = `Local Stockfish unreachable at /api/stockfish/eval. The Vite dev server (npm run dev) or the standalone server (npm start) must be running for line generation.`;
    traceStep(trace, msg);
    return null;
  }

  // One-shot auto-clean: any frontiers left in 'blocked' from prior runs are
  // returned to 'open' so they can be retried under the current engine/threshold
  // settings. The blocked-frontier mechanism is otherwise unused going forward —
  // this exists for migration only and is idempotent.
  const cleared = await clearBlockedFrontiersForRepertoire(rep.id);
  if (cleared > 0) {
    traceStep(trace, `Cleared ${cleared} stale blocked frontier${cleared === 1 ? '' : 's'} from prior runs.`);
  }

  const deadline = Date.now() + TUNING.qualityGateTimeoutMs;
  let lastFailure = 'No attempts were run.';
  let activeScope: FrontierScope | null = null;
  let attemptedCandidates = 0;
  let failedQualityGate = 0;
  let failedNoUserMove = 0;
  let failedOther = 0;
  try {
    const preflightStart = await prepareGenerationStart(rep, openingScope ?? null, trace);
    const preflightScope = scopeFromStart(rep, openingScope ?? null, preflightStart);
    activeScope = preflightScope;
    const existingOpen = await getOpenFrontiers(rep.id, preflightScope.key);
    if (existingOpen.length === 0) {
      traceStep(trace, `Frontier index preflight: no open candidates for scope=${preflightScope.key}; searching for more candidates.`);
      await findTopUnansweredOpponentMove(rep, signal, trace, preflightStart, preflightScope, {
        clearFirst: false,
        maxNodes: TUNING.maxFrontierRebuildNodes,
        maxExplorerCalls: TUNING.maxFrontierExplorerCalls,
        reason: 'preflight-search',
      });
    }
  } catch (e) {
    if (signal?.aborted) return null;
    traceStep(trace, `Frontier index preflight failed: ${describeError(e)}`);
  }

  if (signal?.aborted) {
    traceStep(trace, `Quality gate: aborted before attempt.`);
    return null;
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    traceStep(trace, `Quality gate: timeout before attempt (${TUNING.qualityGateTimeoutMs / 1000}s wall clock).`);
  } else {
    const snapshot = await snapshotGenerationState(rep.id);
    const attemptSignal = makeAttemptSignal(signal, remainingMs);
    let accepted = false;
    try {
      traceStep(trace, `Quality gate: attempt started; ${Math.ceil(remainingMs / 1000)}s remaining.`);
      const line = await generateLearnLineOnce(rep, yourMoveBudget, attemptSignal.signal, trace, openingScope);
      attemptedCandidates++;
      if (signal?.aborted) {
        lastFailure = 'Attempt aborted by parent signal.';
        traceStep(trace, `Quality gate: aborted by parent signal.`);
      } else if (!line) {
        if (attemptSignal.signal.aborted) {
          lastFailure = 'Attempt aborted.';
          traceStep(trace, `Quality gate: aborted.`);
        } else {
          lastFailure = 'Generator returned no line.';
          traceStep(trace, `Quality gate: generator produced no line.`);
        }
      } else {
        if (attemptSignal.signal.aborted) {
          traceStep(trace, `Quality gate: signal timed out, but a line was produced; evaluating it before discarding.`);
        }
        const quality = await evaluateLineQuality(line, rep.color, signal, trace);
        const respectsScope = assertLineRespectsScope(line, rep, openingScope ?? null, trace);
        if (quality.passed && respectsScope) {
          accepted = true;
          traceStep(trace, `Quality gate: accepted.`);
          return line;
        }
        lastFailure = respectsScope ? quality.reason : 'Generated line did not respect the selected opening scope.';
        failedQualityGate++;
        traceStep(trace, `Quality gate: rejected: ${lastFailure}`);
      }
    } catch (e) {
      if (attemptSignal.signal.aborted || signal?.aborted) {
        lastFailure = 'Attempt aborted.';
        traceStep(trace, `Quality gate: aborted during generation.`);
      } else if (e instanceof FrontierGenerationError) {
        if (e.message.toLowerCase().includes('user move')) failedNoUserMove++;
        else failedOther++;
        attemptedCandidates++;
        lastFailure = describeError(e);
        traceStep(trace, `Quality gate: generator threw: ${lastFailure}`);
      } else {
        failedOther++;
        lastFailure = describeError(e);
        traceStep(trace, `Quality gate: generator threw: ${lastFailure}`);
      }
    } finally {
      attemptSignal.cleanup();
      if (!accepted) {
        const restored = await restoreGenerationState(rep.id, snapshot);
        traceStep(trace, `Quality gate: rolled back; deletedEdges=${restored.deletedEdges}, restoredEdges=${restored.restoredEdges}, deletedFrontiers=${restored.deletedFrontiers}, restoredFrontiers=${restored.restoredFrontiers}.`);
      }
    }
  }

  if (activeScope) {
    const [openFinal, allFrontiers, readyFinal] = await Promise.all([
      getOpenFrontiers(rep.id, activeScope.key),
      getFrontiersForRepertoire(rep.id),
      countReadyLines(rep.id, activeScope.key),
    ]);
    const scoped = allFrontiers.filter(frontier => frontierInScope(frontier, activeScope!));
    const counts = frontierStatusCounts(scoped);
    traceStep(trace, `Generation failure summary: scope=${activeScope.key}, attemptedCandidates=${attemptedCandidates}, failedQualityGate=${failedQualityGate}, failedNoUserMove=${failedNoUserMove}, failedOther=${failedOther}, totalKnownFrontiers=${scoped.length}, openFrontiers=${openFinal.length}, blockedFrontiers=${counts.blocked}, answeredFrontiers=${counts.answered}, generatedLineQueueSize=${readyFinal}, lastFailure=${lastFailure}`);
  }
  traceStep(trace, `Quality gate: no acceptable line. Last failure: ${lastFailure}`);
  return null;
}

function makeAttemptSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', abortFromParent, { once: true });
  }
  const timeout = globalThis.setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  return {
    signal: controller.signal,
    cleanup: () => {
      globalThis.clearTimeout(timeout);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

// Scope-leak invariant: when a line is generated for an opening scope, every edge in
// the line's path should walk away from the scope's startFen — i.e., the first edge's
// parentFen should equal startFen, and each subsequent edge's parentFen should equal
// the previous edge's childFen. If we find an edge that walks back to rep.rootFen
// (or anywhere not reachable from the scope), the scope filter has leaked somewhere
// upstream. Logs LOUDLY to the trace; doesn't throw, since "show what we got" is
// better than "show nothing" if the user already invested time.
export function assertLineRespectsScope(
  line: GeneratedLine,
  rep: Repertoire,
  openingScope: GenerationOpeningScope | null,
  trace?: GenerationTrace
): boolean {
  if (!openingScope) return true; // No scope, no constraint.
  // Compute the expected start FEN by walking the scope's moves from the standard start.
  let expectedStart: NormFen = STARTING_FEN_NORM;
  for (const move of openingScope.moves) {
    const r = applyMove(expectedStart, move);
    if (!r) {
      traceStep(trace, `SCOPE-LEAK CHECK: skipped — opening scope "${openingScope.name}" has invalid move "${move}" at ${expectedStart}.`);
      return true;
    }
    expectedStart = r.fen;
  }
  // The first edge of the line must originate at expectedStart (after all opening scope moves).
  const firstEdge = line.fullPath[0];
  if (!firstEdge) return true;
  if (firstEdge.parentFen !== expectedStart) {
    // The line might be allowed to start before the scope's start FEN if the rep root is earlier
    // and the scope path is part of fullPath — check that expectedStart appears somewhere in fullPath.
    const containsScopeStart = line.fullPath.some(e => e.parentFen === expectedStart || e.childFen === expectedStart);
    if (!containsScopeStart) {
      traceStep(trace, `!!! SCOPE LEAK !!! Line generated for scope "${openingScope.name}" (expected startFen=${expectedStart}) does not include that FEN anywhere in its ${line.fullPath.length}-edge path. First edge parentFen=${firstEdge.parentFen}. Repertoire rootFen=${rep.rootFen}. This is the bug — the picker ignored scope.`);
      return false;
    }
  }
  // Verify the path is actually contiguous (no missing links).
  for (let i = 1; i < line.fullPath.length; i++) {
    const prev = line.fullPath[i - 1];
    const cur = line.fullPath[i];
    if (cur.parentFen !== prev.childFen) {
      traceStep(trace, `!!! PATH-CONTIGUITY LEAK !!! Edge ${i} (${cur.san}) parentFen=${cur.parentFen} does not match edge ${i - 1} (${prev.san}) childFen=${prev.childFen}.`);
      return false;
    }
  }
  return true;
}

// Rehydrate a cached ReadyLine back into a GeneratedLine by looking up each edge ID
// from the edges store. If any edge is missing (e.g. the user deleted a subtree since
// the line was cached), returns null so the caller can fall through to live generation.
// Edges always reflect the latest DB state — SRS updates from interim training are
// picked up automatically.
export async function rehydrateReadyLine(ready: ReadyLine): Promise<GeneratedLine | null> {
  const fullPath: Edge[] = [];
  for (const id of ready.fullPathEdgeIds) {
    const edge = await getEdgeById(id);
    if (!edge) return null;
    fullPath.push(edge);
  }
  const newSet = new Set(ready.newEdgeIds);
  const newEdges = fullPath.filter(e => newSet.has(e.id));
  return {
    fullPath,
    newEdges,
    generationStartIndex: ready.generationStartIndex,
    frontierId: ready.frontierId,
    frontierFen: ready.frontierFen,
    selectionReason: 'cache-hit',
  };
}

export async function repairFrontierIndexAfterLearn(
  rep: Repertoire,
  line: GeneratedLine,
  openingScope?: GenerationOpeningScope | null,
  signal?: AbortSignal,
  trace?: GenerationTrace
): Promise<void> {
  const start = await prepareGenerationStart(rep, openingScope ?? null, trace);
  const scope = scopeFromStart(rep, openingScope ?? null, start);
  const candidates: DiscoveredFrontier[] = [];
  const inspected = new Set<NormFen>();
  let explorerCalls = 0;

  const pathToFen = (fen: NormFen): PathStep[] | null => {
    const path: PathStep[] = [];
    let cursor = rep.rootFen;
    if (fen === cursor) return path;
    for (const edge of line.fullPath) {
      if (edge.parentFen !== cursor) return null;
      path.push({
        fromFen: edge.parentFen,
        toFen: edge.childFen,
        san: edge.san,
        uci: edge.uci,
        mover: edge.mover,
        edge,
        popularityFraction: 1,
        source: 'stored',
      });
      cursor = edge.childFen;
      if (cursor === fen) return path;
    }
    return null;
  };

  const affected = new Set<NormFen>();
  for (const edge of line.fullPath) {
    affected.add(edge.parentFen);
    affected.add(edge.childFen);
  }

  traceStep(trace, `Frontier repair start: scope=${scope.key}, affectedPositions=${affected.size}.`);
  for (const fen of affected) {
    if (signal?.aborted) break;
    if (inspected.has(fen) || turnAt(fen) === rep.color || chessFromFen(fen).isGameOver()) continue;
    const path = pathToFen(fen);
    if (!path) continue;
    inspected.add(fen);
    if (explorerCalls >= TUNING.maxFrontierFallbackExplorerCalls) break;
    const stored = await getEdgesFromParent(rep.id, fen);
    explorerCalls++;
    const moves = await getOpponentMovesForFrontier(fen, stored, signal, trace);
    for (const move of moves) {
      const result = applyMove(fen, uciToObj(move.uci)) ?? applyMove(fen, move.san);
      if (!result) continue;
      const childStored = await getEdgesFromParent(rep.id, result.fen);
      const hasUserReply = childStored.some(edge => edge.mover === rep.color && !edge.isScaffold);
      if (hasUserReply) continue;
      const nextPath: PathStep[] = [...path, {
        fromFen: fen,
        toFen: result.fen,
        san: result.san,
        uci: result.uci,
        mover: result.mover,
        edge: move.storedEdge,
        popularityFraction: move.popularityFraction,
        source: move.source,
      }];
      const weight = nextPath.reduce((acc, step) => acc * (step.mover === rep.color ? 1 : Math.max(step.popularityFraction, 0.01)), 1);
      candidates.push({
        fen: result.fen,
        path: nextPath,
        games: move.games,
        weight,
        parentFen: fen,
        san: result.san,
        uci: result.uci,
        mover: result.mover,
        popularityFraction: move.popularityFraction,
        source: move.source,
      });
    }
  }
  await putFrontiers(candidates.map(frontier => frontierCandidateFromDiscovery(rep, frontier, scope)));
  traceStep(trace, `Frontier repair stop: scope=${scope.key}, indexAdded=${candidates.length}, nodesInspected=${inspected.size}, explorerCalls=${explorerCalls}.`);
}

// Stockfish-only line generation used when findTopFrontier returns null (Lichess unavailable or
// repertoire fully covers all popular opponent responses). Walks to the deepest stored leaf and
// extends from there using cloud eval for opponent moves and pickYourMove for user moves.
export async function generateStockfishFallbackLine(
  rep: Repertoire,
  yourMoveBudget: number,
  signal?: AbortSignal,
  trace?: GenerationTrace,
  start?: GenerationStart
): Promise<GeneratedLine | null> {
  const all = await getEdgesForRepertoire(rep.id);
  const byParent = new Map<NormFen, Edge[]>();
  for (const e of all) {
    const arr = byParent.get(e.parentFen) ?? [];
    arr.push(e);
    byParent.set(e.parentFen, arr);
  }

  // DFS from the requested generation root to find the longest path (deepest leaf).
  let bestPath: Edge[] = start?.path ? [...start.path] : [];
  const stack: { fen: NormFen; path: Edge[] }[] = [{ fen: start?.startFen ?? rep.rootFen, path: start?.path ? [...start.path] : [] }];
  const visited = new Set<NormFen>();
  traceStep(trace, `Stockfish-only fallback: scanning ${all.length} stored edges for deepest leaf from ${start?.startFen ?? rep.rootFen}.`);
  while (stack.length) {
    const { fen, path } = stack.pop()!;
    if (visited.has(fen)) continue;
    visited.add(fen);
    const children = byParent.get(fen) ?? [];
    if (children.length === 0 && path.length > bestPath.length) {
      bestPath = path;
      continue;
    }
    for (const e of children) stack.push({ fen: e.childFen, path: [...path, e] });
  }
  traceStep(trace, `Stockfish-only fallback: deepest path length=${bestPath.length}; startFen=${bestPath.length > 0 ? bestPath[bestPath.length - 1].childFen : rep.rootFen}.`);

  const fullPath: Edge[] = [...bestPath];
  const newEdges: Edge[] = [];
  const generationStartIndex = fullPath.length;
  let cursorFen: NormFen = bestPath.length > 0 ? bestPath[bestPath.length - 1].childFen : rep.rootFen;
  let yourMovesAdded = 0;
  let failReason = 'Unknown failure';

  while (yourMovesAdded < yourMoveBudget) {
    if (signal?.aborted) break;
    const turn = turnAt(cursorFen);
    traceStep(trace, `Stockfish-only fallback: loop at ${cursorFen}; turn=${turn}; yourMovesAdded=${yourMovesAdded}/${yourMoveBudget}.`);
    if (chessFromFen(cursorFen).isGameOver()) {
      traceStep(trace, 'Stockfish-only fallback: stopped because position is game-over.');
      break;
    }

    if (turn === rep.color) {
      // Standard pick, then lenient pick (no game-count floor), then any legal move as last resort.
      traceStep(trace, 'Stockfish-only fallback: picking user move with normal picker, then lenient database, then legal fallback.');
      let pick = (await pickYourMove(cursorFen, rep.color, signal, trace))
              ?? (await pickAnyDatabaseMove(cursorFen, rep.color, signal, trace));
      if (!pick) {
        pick = pickFirstLegalMove(cursorFen, trace);
      }
      if (!pick) { failReason = `No legal moves at: ${cursorFen}`; break; }
      traceStep(trace, `Stockfish-only fallback: selected user move ${pick.san} (${pick.uci}) from ${pick.source}.`);
      const existing = (await getEdgesFromParent(rep.id, cursorFen)).find(e => e.uci === pick.uci);
      if (existing) {
        const sourced = await attachMoveSource(existing, pick);
        fullPath.push(sourced);
        cursorFen = sourced.childFen;
        traceStep(trace, `Stockfish-only fallback: reused existing user edge ${sourced.san}.`);
      } else {
        const r = await playMoveInRepertoire(rep.id, cursorFen, pick.san);
        if (!r) { failReason = `playMoveInRepertoire failed for ${pick.san} at ${cursorFen}`; break; }
        const sourced = await attachMoveSource(r.edge, pick);
        fullPath.push(sourced);
        if (r.edgeCreated) newEdges.push(sourced);
        cursorFen = sourced.childFen;
        traceStep(trace, `Stockfish-only fallback: added user edge ${sourced.san}; edgeCreated=${r.edgeCreated}.`);
      }
      yourMovesAdded++;
    } else {
      // Opponent move: try cloud eval, fall back to Lichess explorer.
      let bestUci: string | null = null;
      traceStep(trace, 'Stockfish-only fallback: requesting engine move for opponent.');
      const engine = await fetchLocalEval(cursorFen, TUNING.cloudEvalMultiPv, TUNING.engineDepthLineGen, signal);
      if (engine && engine.pvs.length > 0) {
        bestUci = engine.pvs[0].moves.split(' ')[0];
        traceStep(trace, `Stockfish-only fallback: engine opponent move ${bestUci}, depth=${engine.depth ?? 'unknown'}, pvs=${engine.pvs.length}.`);
      } else {
        traceStep(trace, 'Stockfish-only fallback: engine returned no opponent move; trying Explorer as last resort.');
        try {
          const exp = await fetchExplorer(cursorFen, { source: 'lichess' }, signal);
          if (exp?.moves.length) bestUci = exp.moves[0].uci;
          traceStep(trace, `Stockfish-only fallback: Explorer last resort moves=${exp?.moves.length ?? 0}, selected=${bestUci ?? 'none'}.`);
        } catch (e) {
          if (e instanceof LichessAuthError) {
            traceStep(trace, `Stockfish-only fallback: Lichess auth error, not falling back: ${describeError(e)}`);
            throw e;
          }
          traceStep(trace, `Stockfish-only fallback: Explorer last resort failed: ${describeError(e)}`);
        }
        if (!bestUci) failReason = `No opponent move: cloud eval null, explorer empty/failed at: ${cursorFen}`;
      }
      if (!bestUci) break;
      const existing = (await getEdgesFromParent(rep.id, cursorFen)).find(e => e.uci === bestUci);
      if (existing) {
        fullPath.push(existing);
        cursorFen = existing.childFen;
        traceStep(trace, `Stockfish-only fallback: reused existing opponent edge ${existing.san} (${existing.uci}).`);
      } else {
        const m = applyMove(cursorFen, uciToObj(bestUci));
        if (!m) { failReason = `applyMove failed for ${bestUci} at ${cursorFen}`; break; }
        const r = await playMoveInRepertoire(rep.id, cursorFen, m.san);
        if (!r) { failReason = `playMoveInRepertoire failed for ${m.san} at ${cursorFen}`; break; }
        fullPath.push(r.edge);
        cursorFen = r.edge.childFen;
        traceStep(trace, `Stockfish-only fallback: added opponent edge ${r.edge.san} (${r.edge.uci}).`);
      }
    }
  }

  if (yourMovesAdded === 0) {
    traceStep(trace, `Stockfish-only fallback: failed because zero user moves were added. Reason: ${failReason}`);
    throw new Error(failReason);
  }
  traceStep(trace, `Stockfish-only fallback: success. fullPath=${fullPath.length}, newEdges=${newEdges.length}, generationStartIndex=${generationStartIndex}.`);
  return { fullPath, newEdges, generationStartIndex, selectionReason: 'stockfish-fallback' };
}

export async function continueLearnLine(
  rep: Repertoire,
  fullPathPrefix: Edge[],
  generationStartIndex: number,
  targetYourMoves: number,
  baseNewEdges: Edge[] = [],
  signal?: AbortSignal
): Promise<GeneratedLine> {
  const fullPath = [...fullPathPrefix];
  const newEdges = [...baseNewEdges];
  let cursorFen = fullPath[fullPath.length - 1]?.childFen ?? rep.rootFen;
  let yourMovesAdded = fullPath.slice(generationStartIndex).filter(e => e.mover === rep.color && !e.isScaffold).length;

  while (yourMovesAdded < targetYourMoves) {
    if (signal?.aborted) break;
    const turn = turnAt(cursorFen);
    if (chessFromFen(cursorFen).isGameOver()) break;

    if (turn === rep.color) {
      const pick = await pickYourMove(cursorFen, rep.color, signal);
      if (!pick) break;
      const existing = (await getEdgesFromParent(rep.id, cursorFen)).find(e => e.uci === pick.uci);
      if (existing) {
        const sourced = await attachMoveSource(existing, pick);
        fullPath.push(sourced);
        cursorFen = sourced.childFen;
      } else {
        const r = await playMoveInRepertoire(rep.id, cursorFen, pick.san);
        if (!r) break;
        const sourced = await attachMoveSource(r.edge, pick);
        fullPath.push(sourced);
        if (r.edgeCreated) newEdges.push(sourced);
        cursorFen = sourced.childFen;
      }
      yourMovesAdded++;
    } else {
      const opMoves = await pickOpponentMoves(cursorFen, signal);
      if (opMoves.length === 0) break;
      const sorted = [...opMoves].sort((a, b) => b.popularityFraction - a.popularityFraction);
      const top = sorted[0];
      let topEdge: Edge | null = null;
      for (const om of sorted) {
        const existing = (await getEdgesFromParent(rep.id, cursorFen)).find(e => e.uci === om.uci);
        if (existing) {
          if (om === top) topEdge = existing;
          continue;
        }
        const r = await playMoveInRepertoire(rep.id, cursorFen, om.san);
        if (!r) continue;
        if (om.isMistake) {
          await saveEdgeMistake(r.edge);
          r.edge.isMistake = true;
        }
        if (om === top) topEdge = r.edge;
      }
      if (!topEdge) break;
      fullPath.push(topEdge);
      cursorFen = topEdge.childFen;
    }
  }

  return { fullPath, newEdges, generationStartIndex, selectionReason: 'continue' };
}

function makeActiveSourceLine(pick: YourMovePick): ActiveSourceLine | null {
  if (pick.source !== 'player-book' || !pick.sourceLine || !pick.playerName) return null;
  if (pick.sourceLine.moves.length === 0) return null;
  return { line: pick.sourceLine, index: 1, playerName: pick.playerName };
}

function sourceMoveAt(fen: NormFen, active: ActiveSourceLine): { san: string; uci: string } | null {
  const move = active.line.moves[active.index];
  if (!move || move.color !== turnAt(fen)) return null;
  const applied = applyMove(fen, uciToObj(move.uci)) ?? applyMove(fen, move.san);
  if (!applied) return null;
  return { san: applied.san, uci: applied.uci };
}

function pickFirstLegalMove(fen: NormFen, trace?: GenerationTrace): YourMovePick | null {
  const legalMoves = chessFromFen(fen).moves({ verbose: true });
  if (legalMoves.length === 0) {
    traceStep(trace, `Legal user move fallback: no legal moves at ${fen}.`);
    return null;
  }
  const m = legalMoves[0];
  const pick: YourMovePick = {
    san: m.san,
    uci: m.from + m.to + (m.promotion ?? ''),
    source: 'engine',
  };
  traceStep(trace, `Legal user move fallback: no picker result; using first legal move ${pick.san} (${pick.uci}).`);
  return pick;
}

async function playPickedUserMove(
  rep: Repertoire,
  cursorFen: NormFen,
  pick: YourMovePick
): Promise<{ edge: Edge; edgeCreated: boolean } | null> {
  const existing = (await getEdgesFromParent(rep.id, cursorFen)).find(edge => edge.uci === pick.uci);
  if (existing) {
    return { edge: await attachMoveSource(existing, pick), edgeCreated: false };
  }
  const played = await playMoveInRepertoire(rep.id, cursorFen, pick.san);
  if (!played) return null;
  return { edge: await attachMoveSource(played.edge, pick), edgeCreated: played.edgeCreated };
}

async function playSourceLineMove(
  rep: Repertoire,
  cursorFen: NormFen,
  san: string,
  active: ActiveSourceLine,
  isUserMove: boolean
): Promise<{ edge: Edge; edgeCreated: boolean } | null> {
  const applied = applyMove(cursorFen, san);
  if (!applied) return null;
  const existing = (await getEdgesFromParent(rep.id, cursorFen)).find(edge => edge.uci === applied.uci);
  if (existing) {
    return {
      edge: isUserMove ? await attachSourceLineMetadata(existing, active) : existing,
      edgeCreated: false,
    };
  }
  const played = await playMoveInRepertoire(rep.id, cursorFen, san);
  if (!played) return null;
  return {
    edge: isUserMove ? await attachSourceLineMetadata(played.edge, active) : played.edge,
    edgeCreated: played.edgeCreated,
  };
}

function isTrainableMove(edge: Edge, color: Color): boolean {
  return edge.mover === color && !edge.isScaffold;
}

async function saveEdgeMistake(edge: Edge): Promise<void> {
  await putEdge({ ...edge, isMistake: true });
}

async function attachMoveSource(edge: Edge, pick: YourMovePick): Promise<Edge> {
  if (pick.source !== 'player-book' || !pick.playerName) return edge;
  const sourced: Edge = {
    ...edge,
    recommendationSource: 'player-book',
    sourcePlayerName: pick.playerName,
    sourceGameName: pick.sourceGameName ?? undefined,
    sourceWins: pick.playerWins,
    sourceDraws: pick.playerDraws,
    sourceLosses: pick.playerLosses,
    sourceNet: pick.playerNet,
  };
  await putEdge(sourced);
  return sourced;
}

async function attachSourceLineMetadata(edge: Edge, active: ActiveSourceLine): Promise<Edge> {
  const sourced: Edge = {
    ...edge,
    recommendationSource: 'player-book',
    sourcePlayerName: active.playerName,
    sourceGameName: active.line.label,
  };
  await putEdge(sourced);
  return sourced;
}
