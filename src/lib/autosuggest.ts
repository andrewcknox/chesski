import type { Color, Edge, NormFen, Repertoire } from '../types';
import { applyMove, chessFromFen, turnAt } from './chess';
import { fetchCloudEval, fetchExplorer, LichessAuthError, type CloudEvalResponse, type LichessExplorerResponse, type LichessMove } from './lichess';
import { getEdgesForRepertoire, getEdgesFromParent, playMoveInRepertoire, putEdge } from './storage';
import { getPlayerBookMoves, type PlayerBookPick } from './playerBook';
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
};

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
}

interface MovePop {
  san: string;
  uci: string;
  total: number;
  // Wins for the side whose turn it was (which is the user's color).
  yourWins: number;
  draws: number;
}

function moveToPop(m: LichessMove, color: Color): MovePop {
  const yourWins = color === 'w' ? m.white : m.black;
  return { san: m.san, uci: m.uci, total: m.white + m.draws + m.black, yourWins, draws: m.draws };
}

// Pick the user's preferred move at this position using the ordered sources in settings.
// Database candidates are filtered to moves within evalThresholdPawn of the engine's best,
// then ranked by alpha*popularity + beta*winrate.
export async function pickYourMove(fen: NormFen, color: Color, signal?: AbortSignal): Promise<YourMovePick | null> {
  const settings = await getRecommendationSettings();
  let enginePromise: Promise<CloudEvalResponse | null> | null = null;
  const getEngine = () => {
    enginePromise ??= fetchCloudEval(fen, TUNING.cloudEvalMultiPv, signal);
    return enginePromise;
  };

  for (const source of getEnabledRecommendationOrder(settings)) {
    if (source.kind === 'player-book') {
      const playerPick = await pickEngineSafePlayerBookMove(
        source.key,
        fen,
        color,
        settings.playerBookMaxCpLoss,
        getEngine,
        signal
      );
      if (playerPick) {
        return playerBookPickToYourMove(playerPick);
      }
    } else {
      const databasePick = await pickDatabaseMove(source.key, fen, color, getEngine, signal);
      if (databasePick) return databasePick;
    }
  }

  const engine = await getEngine();
  if (!engine || engine.pvs.length === 0) return null;
  const bestUci = engine.pvs[0].moves.split(' ')[0];
  const m = applyMove(fen, uciToObj(bestUci));
  if (!m) return null;
  return { san: m.san, uci: m.uci, source: 'engine', evalCp: pvCpForSide(engine.pvs[0]) ?? undefined };
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
    const cpLoss = await candidateCpLoss(fen, candidate.uci, getEngine, signal);
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
  };
}

async function pickDatabaseMove(
  source: DatabaseSourceKey,
  fen: NormFen,
  color: Color,
  getEngine: () => Promise<CloudEvalResponse | null>,
  signal?: AbortSignal
): Promise<YourMovePick | null> {
  let candidates: MovePop[] = [];
  try {
    const response = source === 'masters'
      ? await fetchExplorer(fen, { source: 'masters' }, signal)
      : await fetchExplorer(fen, {
        source: 'lichess',
        speeds: 'rapid,classical',
        ratings: '2000,2200,2500',
      }, signal);
    candidates = response.moves.map(m => moveToPop(m, color)).filter(m => m.total >= TUNING.minGamesPerLine);
  } catch (e) {
    if (e instanceof LichessAuthError) throw e;
    return null;
  }
  if (candidates.length === 0) return null;

  const engine = await getEngine();
  const filtered = filterByEngineEval(candidates, engine);
  const winner = rankCandidates(filtered.length > 0 ? filtered : candidates);
  const bestPv = engine ? findPvForMove(engine, winner.uci) : null;
  return {
    san: winner.san,
    uci: winner.uci,
    source,
    evalCp: bestPv ? (pvCpForSide(bestPv) ?? undefined) : undefined,
    popularityFraction: winner.total > 0 ? winner.total / sumTotals(candidates) : 0,
    winRate: decisivenessRate(winner),
  };
}

async function candidateCpLoss(
  fen: NormFen,
  uci: string,
  getEngine: () => Promise<CloudEvalResponse | null>,
  signal?: AbortSignal
): Promise<number | null> {
  const engine = await getEngine();
  if (!engine || engine.pvs.length === 0) return null;
  const bestCp = pvCpForSide(engine.pvs[0]);
  if (bestCp === null) return null;
  const pv = findPvForMove(engine, uci);
  if (pv) {
    const cp = pvCpForSide(pv);
    return cp === null ? null : bestCp - cp;
  }
  const attempted = applyMove(fen, uciToObj(uci));
  if (!attempted) return null;
  const post = await fetchCloudEval(attempted.fen, 1, signal);
  if (!post || post.pvs.length === 0) return null;
  const postCp = pvCpForSide(post.pvs[0]);
  return postCp === null ? null : bestCp + postCp;
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

function filterByEngineEval(candidates: MovePop[], engine: CloudEvalResponse | null): MovePop[] {
  if (!engine || engine.pvs.length === 0) return candidates;
  const bestCp = pvCpForSide(engine.pvs[0]);
  if (bestCp === null) return candidates;
  const minCp = bestCp - TUNING.evalThresholdPawn * 100;
  // Only candidates whose engine eval is within threshold survive.
  // If a candidate isn't in engine PVs, we're conservative and exclude it.
  const out: MovePop[] = [];
  for (const c of candidates) {
    const pv = findPvForMove(engine, c.uci);
    if (!pv) continue;
    const cp = pvCpForSide(pv);
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

// Cloud-eval cp is from the side-to-move perspective. Higher = better for the side to move.
// Mate scores: + means winning mate for STM. Convert to a large cp number.
export function pvCpForSide(pv: import('./lichess').CloudEvalPv): number | null {
  if (pv.cp !== undefined) return pv.cp;
  if (pv.mate !== undefined) return pv.mate > 0 ? 100000 - pv.mate : -100000 - pv.mate;
  return null;
}

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
  const engine = await fetchCloudEval(fen, TUNING.cloudEvalMultiPv, signal);
  const attempted = applyMove(fen, uciToObj(attemptedUci));
  const attemptedSan = attempted?.san ?? null;
  if (!engine || engine.pvs.length === 0) return { cpLoss: null, best: null, attemptedSan };
  const bestPv = engine.pvs[0];
  const bestCp = pvCpForSide(bestPv);
  if (bestCp === null) return { cpLoss: null, best: null, attemptedSan };
  const bestUci = bestPv.moves.split(' ')[0];
  const bestApplied = applyMove(fen, uciToObj(bestUci));
  const bestSan = bestApplied?.san ?? bestUci;
  const best = { uci: bestUci, san: bestSan, cp: bestCp };
  const pv = findPvForMove(engine, attemptedUci);
  if (pv) {
    const cp = pvCpForSide(pv);
    if (cp === null) return { cpLoss: null, best, attemptedSan };
    return { cpLoss: bestCp - cp, best, attemptedSan };
  }
  if (!attempted) return { cpLoss: null, best, attemptedSan };
  // Re-evaluate the resulting position (from opponent's perspective).
  const post = await fetchCloudEval(attempted.fen, 1, signal);
  if (!post || post.pvs.length === 0) return { cpLoss: null, best, attemptedSan };
  const postCp = pvCpForSide(post.pvs[0]);
  if (postCp === null) return { cpLoss: null, best, attemptedSan };
  const attemptedCp = -postCp;
  return { cpLoss: bestCp - attemptedCp, best, attemptedSan };
}

// ---------- Pick OPPONENT moves to enumerate ----------

export interface OpponentMove {
  san: string;
  uci: string;
  popularityFraction: number;
  isMistake: boolean;
}

export async function pickOpponentMoves(fen: NormFen, signal?: AbortSignal): Promise<OpponentMove[]> {
  let resp: LichessExplorerResponse;
  try {
    resp = await fetchExplorer(fen, { source: 'lichess' }, signal);
  } catch (e) {
    if (e instanceof Error) throw new Error(`Lichess explorer unavailable: ${e.message}`);
    throw e;
  }
  const total = resp.white + resp.draws + resp.black;
  if (total === 0) return [];
  const engine = await fetchCloudEval(fen, TUNING.cloudEvalMultiPv, signal);
  const bestCp = engine && engine.pvs.length > 0 ? pvCpForSide(engine.pvs[0]) : null;
  const out: OpponentMove[] = [];
  for (const m of resp.moves) {
    const games = m.white + m.draws + m.black;
    const frac = games / total;
    if (frac < TUNING.opponentPopularityFraction) continue;
    let isMistake = false;
    if (engine && bestCp !== null) {
      const pv = findPvForMove(engine, m.uci);
      const cp = pv ? pvCpForSide(pv) : null;
      if (cp !== null && bestCp - cp >= TUNING.mistakeThresholdPawn * 100) isMistake = true;
    }
    out.push({ san: m.san, uci: m.uci, popularityFraction: frac, isMistake });
  }
  return out;
}

// ---------- Find the priority frontier ----------

// A frontier is a position where (a) it's the user's color to move, (b) the path from rootFen
// to this position uses only stored edges where the user has made a choice, plus implicit
// "most popular opponent move" edges where the opponent has no stored move yet, and (c) the
// user has no stored move at this position.
//
// We score each frontier by cumulative probability (multiply opponent popularities along the
// path; user-move steps contribute weight 1).
//
// Search is bounded to keep things tractable.

export interface FrontierResult {
  fen: NormFen;
  cumulativeProbability: number;
  // The path of edges/moves leading to this frontier. Each step is either a stored edge or a
  // proposed implicit opponent move (still represented as SAN/UCI but `edgeId` is null).
  path: PathStep[];
}

export interface PathStep {
  fromFen: NormFen;
  toFen: NormFen;
  san: string;
  uci: string;
  mover: Color;
  edge: Edge | null; // null == implicit opponent move not yet in repertoire
  popularityFraction: number; // 1.0 for user moves; explorer fraction for opponent moves
}

// Build a frontier candidate by walking from rootFen. At each step:
//   - If your turn:
//       - If you have stored move(s), pick the most-popular opponent path... wait that's wrong.
//       - Actually: if your turn and you have stored move(s), follow EACH stored your-move
//         (for branch enumeration we'd fan out). For v1 simplicity: follow ANY one stored your-move
//         (we'll try each as a separate candidate).
//       - If your turn and NO stored move at this fen → THIS is a frontier.
//   - If opponent turn:
//       - If you have stored opponent moves at this fen, you've chosen which to handle. Walk
//         each one as a separate candidate (weighted by its popularity fraction).
//       - For non-stored opponent moves above the popularity threshold, we ALSO walk those (as
//         implicit edges) — that's how we discover frontiers under unhandled branches.
export async function findTopFrontier(rep: Repertoire, signal?: AbortSignal): Promise<FrontierResult | null> {
  const all = await getEdgesForRepertoire(rep.id);
  const byParent = new Map<NormFen, Edge[]>();
  for (const e of all) {
    let arr = byParent.get(e.parentFen);
    if (!arr) { arr = []; byParent.set(e.parentFen, arr); }
    arr.push(e);
  }

  const frontiers: FrontierResult[] = [];

  // Cap on total work to keep this responsive on large repertoires.
  const NODE_BUDGET = 800;
  let nodesVisited = 0;

  type Stack = { fen: NormFen; weight: number; path: PathStep[] };
  const stack: Stack[] = [{ fen: rep.rootFen, weight: 1, path: [] }];

  while (stack.length && nodesVisited < NODE_BUDGET) {
    if (signal?.aborted) break;
    const cur = stack.pop()!;
    nodesVisited++;
    const turn = turnAt(cur.fen);
    const stored = byParent.get(cur.fen) || [];
    const isGameOver = chessFromFen(cur.fen).isGameOver();
    if (isGameOver) continue;

    if (turn === rep.color) {
      // Your turn at this fen.
      if (stored.length === 0) {
        // Frontier!
        frontiers.push({ fen: cur.fen, cumulativeProbability: cur.weight, path: cur.path });
        continue;
      }
      // Otherwise, follow each stored move (your moves).
      for (const e of stored) {
        if (e.mover !== rep.color) continue; // safety: shouldn't happen
        stack.push({
          fen: e.childFen,
          weight: cur.weight, // your move doesn't change probability
          path: [...cur.path, {
            fromFen: e.parentFen, toFen: e.childFen, san: e.san, uci: e.uci, mover: e.mover, edge: e,
            popularityFraction: 1,
          }],
        });
      }
    } else {
      // Opponent's turn. Walk both stored and unstored above-threshold opponent moves.
      // For unstored, query the explorer for popularities (used as edge weights).
      let opponentMoves: { san: string; uci: string; popularityFraction: number; isMistake: boolean; storedEdge: Edge | null }[];
      if (stored.length > 0) {
        // Use the popularities for each stored opponent move from the explorer.
        let exp: LichessExplorerResponse | null = null;
        try {
          exp = await fetchExplorer(cur.fen, { source: 'lichess' }, signal);
        } catch (e) {
          if (e instanceof LichessAuthError) throw e;
        }
        const total = exp ? exp.white + exp.draws + exp.black : 0;
        opponentMoves = stored.map(e => {
          const m = exp?.moves.find(x => x.uci === e.uci);
          const games = m ? m.white + m.draws + m.black : 0;
          return {
            san: e.san, uci: e.uci, popularityFraction: total > 0 && m ? games / total : 0,
            isMistake: false, storedEdge: e,
          };
        });
      } else {
        // No stored opponent moves; enumerate top-popular ones from the explorer (don't walk
        // mistake-tagged moves as deeply — but for frontier discovery we still walk them since
        // they become Crushing-style branches the user needs to handle).
        const top = await pickOpponentMoves(cur.fen, signal);
        opponentMoves = top.map(t => ({ ...t, storedEdge: null }));
      }
      for (const om of opponentMoves) {
        const result = applyMove(cur.fen, om.san);
        if (!result) continue;
        const newWeight = cur.weight * (om.popularityFraction || 0.01);
        if (newWeight < 0.001) continue; // prune very-low-probability branches
        stack.push({
          fen: result.fen,
          weight: newWeight,
          path: [...cur.path, {
            fromFen: cur.fen, toFen: result.fen, san: om.san, uci: om.uci, mover: result.mover,
            edge: om.storedEdge, popularityFraction: om.popularityFraction,
          }],
        });
      }
    }
  }

  if (frontiers.length === 0) return null;
  // Pick the highest-cumulative-probability frontier.
  frontiers.sort((a, b) => b.cumulativeProbability - a.cumulativeProbability);
  return frontiers[0];
}

// ---------- Generate a learn-line ----------

// From a frontier (where it's your turn and you have no stored move), generate a sequence
// of plies: 5 of YOUR moves, with intervening top-popular opponent moves automatically added
// to the repertoire. Returns the sequence of newly-created OR newly-touched edges representing
// the line for the learn phase.
//
// Side effect: persists all path-leading edges (from rep root → frontier) and all generated
// edges (frontier → end of line) into the repertoire.
export interface GeneratedLine {
  // The full sequence of edges from rep root → end of generated line, in order.
  fullPath: Edge[];
  // The subset of edges newly added during generation (used for the learn-test SRS scope).
  newEdges: Edge[];
  // Index into fullPath where the generation began (i.e., the frontier).
  generationStartIndex: number;
}

export async function generateLearnLine(
  rep: Repertoire,
  yourMoveBudget = 5,
  signal?: AbortSignal
): Promise<GeneratedLine | null> {
  const frontier = await findTopFrontier(rep, signal);
  if (!frontier) return null;

  // Step 1: persist any implicit opponent edges along the path to the frontier.
  // These were "implicit" during traversal but should now exist as real edges so the
  // repertoire reflects what we trained.
  const fullPath: Edge[] = [];
  let cursorFen = rep.rootFen;
  for (const step of frontier.path) {
    if (step.edge) {
      fullPath.push(step.edge);
    } else {
      const r = await playMoveInRepertoire(rep.id, cursorFen, step.san);
      if (!r) return null;
      fullPath.push(r.edge);
    }
    cursorFen = step.toFen;
  }

  // Step 2: from the frontier, generate up to `yourMoveBudget` of your moves with intervening
  // top-popular opponent moves.
  const newEdges: Edge[] = [];
  const generationStartIndex = fullPath.length;
  let yourMovesAdded = 0;
  while (yourMovesAdded < yourMoveBudget) {
    if (signal?.aborted) break;
    const turn = turnAt(cursorFen);
    if (chessFromFen(cursorFen).isGameOver()) break;

    if (turn === rep.color) {
      const pick = await pickYourMove(cursorFen, rep.color, signal);
      if (!pick) break;
      // Check whether an edge already exists (e.g. transposition).
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
      // Opponent move: pick the most-popular response. Also add ALL above-threshold opponent
      // moves to the repertoire as branches (so the user has scaffolding to face them in
      // future sessions), but only follow the top-popular one for THIS line.
      const opMoves = await pickOpponentMoves(cursorFen, signal);
      if (opMoves.length === 0) break;
      const sorted = [...opMoves].sort((a, b) => b.popularityFraction - a.popularityFraction);
      const top = sorted[0];
      // Add all branches.
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

  if (yourMovesAdded === 0) return null;
  return { fullPath, newEdges, generationStartIndex };
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
  let yourMovesAdded = fullPath.slice(generationStartIndex).filter(e => e.mover === rep.color).length;

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

  return { fullPath, newEdges, generationStartIndex };
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
