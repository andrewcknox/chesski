import type { Color, Edge, FrontierCandidate, FrontierSource, NormFen, ReadyLine, Repertoire } from '../types';
import { frontierId } from '../types';
import { applyMove, chessFromFen, STARTING_FEN_NORM, turnAt } from './chess';
import { fetchCloudEval, fetchExplorer, LichessAuthError, type CloudEvalResponse, type LichessExplorerResponse, type LichessMove } from './lichess';
import {
  addMovesToRepertoire,
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
import { getPlayerBookMoves, type PlayerBookPick, type PlayerBookSourceLine } from './playerBook';
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
  // Keep this aligned with line generation so the gate does not veto depth-18 choices
  // with a stricter, semantically different search.
  engineDepthGate: 18,
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
  qualityGateMaxAttempts: 3,
  qualityGateTimeoutMs: 120_000,
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
      enginePromise = fetchCloudEval(fen, TUNING.cloudEvalMultiPv, TUNING.engineDepthSelect, signal).then(engine => {
        traceStep(trace, engine
          ? `Your move picker: engine returned ${engine.pvs.length} PVs at depth ${engine.depth ?? 'unknown'}.`
          : 'Your move picker: engine returned no eval.');
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
      traceStep(trace, `Your move picker: trying player book ${source.key}.`);
      const playerPick = await pickEngineSafePlayerBookMove(
        source.key,
        fen,
        color,
        settings.playerBookMaxCpLoss,
        getEngine,
        signal
      );
      if (playerPick) {
        traceStep(trace, `Your move picker: player book selected ${playerPick.san} (${playerPick.uci}), cpLoss=${playerPick.cpLoss ?? 'unknown'}.`);
        return playerBookPickToYourMove(playerPick);
      }
      traceStep(trace, `Your move picker: player book ${source.key} had no usable move.`);
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

async function pickEngineSafePlayerBookMove(
  playerKey: PlayerKey,
  fen: NormFen,
  color: Color,
  maxCpLoss: number,
  getEngine: () => Promise<CloudEvalResponse | null>,
  signal?: AbortSignal
): Promise<(PlayerBookPick & { cpLoss: number | null }) | null> {
  const candidates = await getPlayerBookMoves(playerKey, fen, color, signal);
  for (const candidate of candidates) {
    const cpLoss = await candidateCpLoss(fen, candidate.uci, color, getEngine, signal);
    if (cpLoss === null || cpLoss <= maxCpLoss) {
      return { ...candidate, cpLoss };
    }
  }
  return null;
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

async function candidateCpLoss(
  fen: NormFen,
  uci: string,
  color: Color,
  getEngine: () => Promise<CloudEvalResponse | null>,
  signal?: AbortSignal
): Promise<number | null> {
  const engine = await getEngine();
  if (!engine || engine.pvs.length === 0) return null;
  const bestCp = pvCpForColor(engine.pvs[0], color);
  if (bestCp === null) return null;
  const pv = findPvForMove(engine, uci);
  if (pv) {
    const cp = pvCpForColor(pv, color);
    return cp === null ? null : bestCp - cp;
  }
  const attempted = applyMove(fen, uciToObj(uci));
  if (!attempted) return null;
  const post = await fetchCloudEval(attempted.fen, 1, TUNING.engineDepthLineGen, signal);
  if (!post || post.pvs.length === 0) return null;
  const postCp = pvCpForColor(post.pvs[0], color);
  return postCp === null ? null : bestCp - postCp;
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
  const engine = await fetchCloudEval(fen, TUNING.cloudEvalMultiPv, TUNING.engineDepthLineGen, signal);
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
  const post = await fetchCloudEval(attempted.fen, 1, TUNING.engineDepthLineGen, signal);
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

export interface LineQualityResult {
  passed: boolean;
  startCp: number | null;
  endCp: number | null;
  dropCp: number | null;
  thresholdCp: number;
  reason: string;
  mateLost: boolean;
}

function isWinningMate(cp: number | null): boolean {
  return cp !== null && cp > 90000;
}

// Re-evaluate the start and end positions of a generated line at TUNING.engineDepthGate
// and decide whether the line passed the quality gate.
//
// Pass conditions (in order):
//  1. If start is a winning mate and end is not → FAIL (mate lost).
//  2. If either eval is unavailable → SKIP (treated as pass; can't judge what we can't measure).
//  3. If (startCp - endCp) > thresholdFromMaxAllowedDropPawns(startCp) → FAIL.
//  4. Otherwise → PASS.
//
// Every decision is written to the GenerationTrace so it appears in the train UI's
// trace panel and the copy-paste log.
export async function evaluateLineQuality(
  startFen: NormFen,
  endFen: NormFen,
  color: Color,
  signal?: AbortSignal,
  trace?: GenerationTrace
): Promise<LineQualityResult> {
  if (startFen === endFen) {
    const r: LineQualityResult = { passed: true, startCp: null, endCp: null, dropCp: null,
      thresholdCp: 0, reason: 'Start and end FEN identical; gate trivially passes', mateLost: false };
    traceStep(trace, `Quality gate: SKIP — ${r.reason}.`);
    return r;
  }
  traceStep(trace, `Quality gate: deep-eval start=${startFen} and end=${endFen} at depth ${TUNING.engineDepthGate}.`);
  const [startEval, endEval] = await Promise.all([
    fetchCloudEval(startFen, 1, TUNING.engineDepthGate, signal),
    fetchCloudEval(endFen,   1, TUNING.engineDepthGate, signal),
  ]);
  const startCp = startEval && startEval.pvs[0] ? pvCpForColor(startEval.pvs[0], color) : null;
  const endCp   = endEval   && endEval.pvs[0]   ? pvCpForColor(endEval.pvs[0],   color) : null;

  const startWinMate = isWinningMate(startCp);
  const endWinMate   = isWinningMate(endCp);
  if (startWinMate && !endWinMate) {
    const r: LineQualityResult = { passed: false, startCp, endCp, dropCp: null,
      thresholdCp: 0, reason: `Lost a winning mate (startCp=${startCp}, endCp=${endCp})`, mateLost: true };
    traceStep(trace, `Quality gate: FAIL — ${r.reason}.`);
    return r;
  }
  if (startCp === null || endCp === null) {
    const r: LineQualityResult = { passed: true, startCp, endCp, dropCp: null,
      thresholdCp: 0, reason: `No engine eval available (startCp=${startCp}, endCp=${endCp}); gate skipped`, mateLost: false };
    traceStep(trace, `Quality gate: SKIP — ${r.reason}.`);
    return r;
  }
  const startPawns = startCp / 100;
  const thresholdPawns = maxAllowedDropPawns(startPawns);
  const thresholdCp = thresholdPawns * 100;
  const dropCp = startCp - endCp;
  const dropPawns = dropCp / 100;
  const passed = dropCp <= thresholdCp;
  const reason = passed
    ? `Drop ${dropPawns.toFixed(2)} <= threshold ${thresholdPawns.toFixed(2)} (start ${startPawns.toFixed(2)} -> end ${(endCp / 100).toFixed(2)})`
    : `Drop ${dropPawns.toFixed(2)} > threshold ${thresholdPawns.toFixed(2)} (start ${startPawns.toFixed(2)} -> end ${(endCp / 100).toFixed(2)})`;
  const r: LineQualityResult = { passed, startCp, endCp, dropCp, thresholdCp, reason, mateLost: false };
  traceStep(trace, `Quality gate: ${passed ? 'PASS' : 'FAIL'} — ${reason}.`);
  return r;
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

  const engine = await fetchCloudEval(fen, TUNING.cloudEvalMultiPv, depth, signal);
  return opponentMovesFromExplorer(fen, resp, total, engine, trace);
}

async function opponentMovesFromStockfish(fen: NormFen, signal?: AbortSignal, trace?: GenerationTrace, depth: number = TUNING.engineDepthLineGen): Promise<OpponentMove[]> {
  traceStep(trace, `Stockfish fallback: requesting ${TUNING.cloudEvalMultiPv} PVs at ${fen}`);
  const engine = await fetchCloudEval(fen, TUNING.cloudEvalMultiPv, depth, signal);
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

interface FrontierScope {
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
  if (!openingScope) return 'root';
  let startFen: NormFen = STARTING_FEN_NORM;
  for (const move of openingScope.moves) {
    const r = applyMove(startFen, move);
    if (!r) return null; // invalid opening definition; caller should treat as no scope
    startFen = r.fen;
  }
  return `${rep.color}:${openingScope.key}:${rep.rootFen}:${startFen}`;
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
function frontierInScope(frontier: FrontierCandidate, scope: FrontierScope): boolean {
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
  while (yourMovesAdded < yourMoveBudget) {
    if (signal?.aborted) break;
    const turn = turnAt(cursorFen);
    traceStep(trace, `Line generation: extension loop at ${cursorFen}; turn=${turn}; yourMovesAdded=${yourMovesAdded}/${yourMoveBudget}.`);
    if (chessFromFen(cursorFen).isGameOver()) {
      traceStep(trace, 'Line generation: stopped because position is game-over.');
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
        break;
      }
      traceStep(trace, `Line generation: picked user move ${pick.san} (${pick.uci}) from ${pick.source}.`);
      const played = await playPickedUserMove(rep, cursorFen, pick);
      if (!played) {
        traceStep(trace, `Line generation: could not play picked user move ${pick.san} at ${cursorFen}.`);
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

// Quality-gated wrapper around generateLearnLineOnce. Generates a line, then
// deep-evaluates its start and end FENs at TUNING.engineDepthGate and logs
// PASS/FAIL with full reasoning. The line is returned regardless — the gate is a
// diagnostic, not a rejection. Failures show up in the trace panel and the
// copy-paste log so you can see exactly why a line is leaking advantage.
//
// On FAIL, the wrapper rolls back generated edges, marks the specific frontier
// blocked after rollback, and lets the next attempt select another indexed candidate.
export async function generateLearnLine(
  rep: Repertoire,
  yourMoveBudget = 5,
  signal?: AbortSignal,
  trace?: GenerationTrace,
  openingScope?: GenerationOpeningScope | null
): Promise<GeneratedLine | null> {
  const deadline = Date.now() + TUNING.qualityGateTimeoutMs;
  let lastFailure = 'No attempts were run.';
  let activeScope: FrontierScope | null = null;
  let activeStart: GenerationStart | null = null;
  let unblockedFailureCount = 0;
  let attemptedCandidates = 0;
  let failedQualityGate = 0;
  let failedNoUserMove = 0;
  let failedOther = 0;
  try {
    const preflightStart = await prepareGenerationStart(rep, openingScope ?? null, trace);
    const preflightScope = scopeFromStart(rep, openingScope ?? null, preflightStart);
    activeScope = preflightScope;
    activeStart = preflightStart;
    const existingOpen = await getOpenFrontiers(rep.id, preflightScope.key);
    if (existingOpen.length === 0) {
      traceStep(trace, `Frontier index preflight: no open candidates for scope=${preflightScope.key}; searching for more candidates without unblocking rejected ones.`);
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

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) {
      traceStep(trace, `Quality gate: aborted before attempt ${attempt}.`);
      return null;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      traceStep(trace, `Quality gate: timeout before attempt ${attempt} (${TUNING.qualityGateTimeoutMs / 1000}s wall clock).`);
      break;
    }
    if (activeScope && attempt > 1) {
      const openBeforeAttempt = await getOpenFrontiers(rep.id, activeScope.key);
      if (openBeforeAttempt.length === 0) {
        traceStep(trace, `Frontier index: no open candidates remain for scope=${activeScope.key}; running final search without unblocking rejected candidates.`);
        const searchStart = activeStart ?? await prepareGenerationStart(rep, openingScope ?? null, trace);
        await findTopUnansweredOpponentMove(rep, signal, trace, searchStart, activeScope, {
          clearFirst: false,
          maxNodes: TUNING.maxFrontierRebuildNodes,
          maxExplorerCalls: TUNING.maxFrontierExplorerCalls,
          reason: 'final-frontier-search',
        });
        const openAfterRebuild = await getOpenFrontiers(rep.id, activeScope.key);
        if (openAfterRebuild.length === 0) {
          lastFailure = 'No open frontier candidates remained after rebuild/search.';
          traceStep(trace, `Frontier index: final search produced no open candidates for scope=${activeScope.key}.`);
          break;
        }
      }
    }

    const snapshot = await snapshotGenerationState(rep.id);
    const attemptSignal = makeAttemptSignal(signal, remainingMs);
    let accepted = false;
    let rejectedFrontierId: string | undefined;
    let rejectedReason: string | undefined;
    try {
      traceStep(trace, `Quality gate: attempt ${attempt} started; ${Math.ceil(remainingMs / 1000)}s remaining.`);
      const line = await generateLearnLineOnce(rep, yourMoveBudget, attemptSignal.signal, trace, openingScope);
      attemptedCandidates++;
      if (signal?.aborted) {
        lastFailure = 'Attempt aborted by parent signal.';
        traceStep(trace, `Quality gate: attempt ${attempt} aborted by parent signal.`);
        break;
      }
      if (!line) {
        if (attemptSignal.signal.aborted) {
          lastFailure = 'Attempt aborted.';
          traceStep(trace, `Quality gate: attempt ${attempt} aborted.`);
          break;
        }
        lastFailure = 'Generator returned no line.';
        traceStep(trace, `Quality gate: attempt ${attempt} produced no line.`);
      } else {
        if (attemptSignal.signal.aborted) {
          traceStep(trace, `Quality gate: attempt ${attempt} signal timed out, but a line was produced; evaluating it before discarding.`);
        }
        const startFen = line.fullPath[line.generationStartIndex - 1]?.childFen ?? rep.rootFen;
        const endFen = line.fullPath[line.fullPath.length - 1]?.childFen ?? startFen;
        const quality = await evaluateLineQuality(startFen, endFen, rep.color, signal, trace);
        const respectsScope = assertLineRespectsScope(line, rep, openingScope ?? null, trace);
        if (quality.passed && respectsScope) {
          accepted = true;
          traceStep(trace, `Quality gate: attempt ${attempt} accepted.`);
          return line;
        }
        lastFailure = respectsScope ? quality.reason : 'Generated line did not respect the selected opening scope.';
        rejectedFrontierId = line.frontierId;
        rejectedReason = `Quality gate rejected this generated line: ${lastFailure}`;
        failedQualityGate++;
        traceStep(trace, `Quality gate: attempt ${attempt} rejected: ${lastFailure}`);
      }
    } catch (e) {
      if (attemptSignal.signal.aborted || signal?.aborted) {
        lastFailure = 'Attempt aborted.';
        traceStep(trace, `Quality gate: attempt ${attempt} aborted during generation.`);
        break;
      }
      if (e instanceof FrontierGenerationError) {
        rejectedFrontierId = e.frontierId;
        rejectedReason = e.message;
        if (e.message.toLowerCase().includes('user move')) failedNoUserMove++;
        else failedOther++;
        attemptedCandidates++;
      } else {
        failedOther++;
      }
      lastFailure = describeError(e);
      traceStep(trace, `Quality gate: attempt ${attempt} threw: ${lastFailure}`);
    } finally {
      attemptSignal.cleanup();
      if (!accepted) {
        const restored = await restoreGenerationState(rep.id, snapshot);
        traceStep(trace, `Quality gate: rolled back attempt ${attempt}; deletedEdges=${restored.deletedEdges}, restoredEdges=${restored.restoredEdges}, deletedFrontiers=${restored.deletedFrontiers}, restoredFrontiers=${restored.restoredFrontiers}.`);
        if (rejectedFrontierId && rejectedReason) {
          await markFrontierBlocked(rejectedFrontierId, rejectedReason);
          traceStep(trace, `Frontier index: marked ${rejectedFrontierId} blocked after rollback. reason=${rejectedReason}`);
          unblockedFailureCount = 0;
        } else {
          unblockedFailureCount++;
          if (unblockedFailureCount >= TUNING.qualityGateMaxAttempts) {
            traceStep(trace, `Quality gate: stopping after ${unblockedFailureCount} failure(s) that were not tied to a specific frontier.`);
            break;
          }
        }
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
  traceStep(trace, `Quality gate: no acceptable line before frontier exhaustion or ${TUNING.qualityGateTimeoutMs / 1000}s timeout. Last failure: ${lastFailure}`);
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
      const engine = await fetchCloudEval(cursorFen, TUNING.cloudEvalMultiPv, TUNING.engineDepthLineGen, signal);
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
