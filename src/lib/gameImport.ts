import { Chess } from 'chess.js';
import type { Color, NormFen } from '../types';
import { applyMove, normalizeFen, STARTING_FEN_NORM, turnAt } from './chess';
import { evaluateMoveCpLoss } from './autosuggest';
import { fetchExplorer, type LichessExplorerResponse } from './lichess';
import { CURATED_OPENINGS, type CuratedOpening } from './openings';

export type ImportSource = 'chesscom' | 'lichess' | 'pgn';
export type ImportSpeed = 'bullet' | 'blitz' | 'rapid';

export interface ImportOptions {
  source: ImportSource;
  username: string;
  side: Color;
  speeds: ImportSpeed[];
  pgn?: string;
  chessComMonths?: number | 'all';
  gameLimit?: number;
  cpLossThreshold: number;
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
}

export interface ParsedImportGame {
  id: string;
  white: string;
  black: string;
  result: string;
  speed: ImportSpeed | 'other';
  pgn: string;
  moves: ImportMove[];
}

export interface ImportMove {
  san: string;
  uci: string;
  color: Color;
  before: NormFen;
  after: NormFen;
}

export interface ImportDraft {
  username: string;
  side: Color;
  speeds: ImportSpeed[];
  gamesImported: number;
  gamesMatched: number;
  cpLossThreshold: number;
  roots: RootDraft[];
  skippedReason?: string;
}

export interface RootDraft {
  opening: CuratedOpening;
  gameCount: number;
  matchedGameIds: string[];
  lines: string[][];
  decisions: ImportDecision[];
}

export interface ImportDecision {
  id: string;
  openingKey: string;
  ply: number;
  fen: NormFen;
  kind: 'kept' | 'replaced';
  playedSan: string;
  playedUci: string;
  chosenSan: string;
  chosenUci: string;
  games: number;
  masterGames: number;
  cpLoss: number | null;
  reason: string;
}

interface RootGame {
  game: ParsedImportGame;
  startIndex: number;
}

interface TreeNode {
  fen: NormFen;
  incoming: ImportMove | null;
  games: number;
  children: Map<string, TreeNode>;
}

interface FenMoveStat {
  uci: string;
  san: string;
  games: number;
  childFen: NormFen;
}

interface PlayerDecisionCache {
  kind: 'kept' | 'replaced';
  chosenUci: string;
  chosenSan: string;
}

const MAX_PLIES_AFTER_ROOT = 18;
const MAX_PLAYER_DECISIONS_PER_ROOT = 6;
const MAX_PLAYER_CANDIDATES = 4;
const MAX_OPPONENT_BRANCHES = 3;
const MIN_OPPONENT_FRACTION = 0.16;
const NO_MASTER_CP_THRESHOLD = 15;

export const ALGORITHM_TOOLTIP =
  'Chesski scores moves by your game frequency, fit inside the selected preset opening, master-game support, centipawn loss, and whether the move conflicts with the one-continuation rule. Default max loss is 75 cp; if the master database has no games, Chesski keeps a move only when the loss is 15 cp or less.';

export async function buildImportDraft(options: ImportOptions): Promise<ImportDraft> {
  const games = options.source === 'chesscom'
    ? await fetchChessComGames(options)
    : options.source === 'lichess'
      ? await fetchLichessGames(options)
      : parsePgnGames(options.pgn ?? '', options.username);
  const filtered = games.filter(game => gameMatchesOptions(game, options));
  options.onStatus?.(`Found ${filtered.length} ${sideName(options.side)} ${speedLabel(options.speeds)} game${filtered.length === 1 ? '' : 's'}.`);

  const roots: RootDraft[] = [];
  let gamesMatched = 0;
  for (const opening of CURATED_OPENINGS.filter(item => item.color === options.side)) {
    if (options.signal?.aborted) break;
    options.onStatus?.(`Checking ${opening.name}...`);
    const rootGames = findGamesAtRoot(filtered, opening);
    if (rootGames.length === 0) continue;
    gamesMatched += rootGames.length;
    const tree = buildRootTree(rootGames, opening);
    const fenMoveStats = buildFenMoveStats(rootGames);
    const playerDecisionsByFen = new Map<NormFen, PlayerDecisionCache>();
    const decisions: ImportDecision[] = [];
    const lines = await synthesizeLines({
      opening,
      node: tree,
      path: [...opening.moves],
      decisions,
      cpLossThreshold: options.cpLossThreshold,
      playerDecisionCount: 0,
      fenMoveStats,
      playerDecisionsByFen,
      signal: options.signal,
    });
    roots.push({
      opening,
      gameCount: rootGames.length,
      matchedGameIds: rootGames.map(item => item.game.id),
      lines: uniqueLines(lines.filter(line => line.length > opening.moves.length)),
      decisions,
    });
  }

  roots.sort((a, b) => b.gameCount - a.gameCount || a.opening.name.localeCompare(b.opening.name));
  return {
    username: options.username.trim(),
    side: options.side,
    speeds: options.speeds,
    gamesImported: filtered.length,
    gamesMatched,
    cpLossThreshold: options.cpLossThreshold,
    roots,
    skippedReason: filtered.length === 0 ? 'No games matched those filters.' : roots.length === 0 ? 'No games reached one of Chesski\'s preset opening roots.' : undefined,
  };
}

async function fetchChessComGames(options: ImportOptions): Promise<ParsedImportGame[]> {
  const username = normalizeChessComUsername(options.username);
  if (!username) throw new Error('Enter a Chess.com username.');
  options.onStatus?.('Finding Chess.com archives...');
  const archiveRes = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`, { signal: options.signal });
  if (archiveRes.status === 404) {
    throw new Error(`Chess.com could not find public game archives for "${username}". Check the spelling, paste just the profile name, or upload a PGN instead.`);
  }
  if (!archiveRes.ok) throw new Error(`Chess.com archives returned ${archiveRes.status}. If the browser blocks this, upload a PGN instead.`);
  const archiveData = (await archiveRes.json()) as { archives?: string[] };
  const archives = archiveData.archives ?? [];
  const selectedArchives = options.chessComMonths === 'all' ? archives : archives.slice(-Math.max(1, options.chessComMonths ?? 12));
  const games: ParsedImportGame[] = [];

  for (const [idx, url] of selectedArchives.entries()) {
    if (options.signal?.aborted) break;
    options.onStatus?.(`Downloading archive ${idx + 1} of ${selectedArchives.length}...`);
    const res = await fetch(url, { signal: options.signal });
    if (!res.ok) continue;
    const data = (await res.json()) as {
      games?: Array<{
        url?: string;
        pgn?: string;
        time_class?: string;
        white?: { username?: string };
        black?: { username?: string };
      }>;
    };
    for (const raw of data.games ?? []) {
      if (!raw.pgn) continue;
      const parsed = parseSinglePgn(raw.pgn, username, raw.url ?? `${url}-${games.length}`);
      if (!parsed) continue;
      games.push({
        ...parsed,
        white: raw.white?.username ?? parsed.white,
        black: raw.black?.username ?? parsed.black,
        speed: chessComSpeed(raw.time_class) ?? parsed.speed,
      });
    }
  }
  return games;
}

async function fetchLichessGames(options: ImportOptions): Promise<ParsedImportGame[]> {
  const username = normalizeLichessUsername(options.username);
  if (!username) throw new Error('Enter a Lichess username.');
  options.onStatus?.('Downloading Lichess games...');
  const params = new URLSearchParams({
    perfType: options.speeds.join(','),
    color: options.side === 'w' ? 'white' : 'black',
    max: String(options.gameLimit ?? 500),
    moves: 'true',
    tags: 'true',
    clocks: 'false',
    evals: 'false',
    opening: 'false',
    sort: 'dateDesc',
  });
  const res = await fetch(`https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params.toString()}`, {
    signal: options.signal,
    headers: { Accept: 'application/x-chess-pgn' },
  });
  if (res.status === 404) {
    throw new Error(`Lichess could not find public games for "${username}". Check the spelling, paste just the profile name, or upload a PGN instead.`);
  }
  if (!res.ok) throw new Error(`Lichess games returned ${res.status}. Upload a PGN if the live import is unavailable.`);
  const text = await res.text();
  return parsePgnGames(text, username).map(game => ({
    ...game,
    speed: lichessSpeedFromHeaders(game.pgn) ?? game.speed,
  }));
}

function parsePgnGames(pgn: string, username: string): ParsedImportGame[] {
  return splitPgn(pgn)
    .map((gamePgn, idx) => parseSinglePgn(gamePgn, username, `pgn-${idx}`))
    .filter((game): game is ParsedImportGame => Boolean(game));
}

function parseSinglePgn(pgn: string, _username: string, fallbackId: string): ParsedImportGame | null {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn, { strict: false });
  } catch {
    return null;
  }
  const headers = chess.header();
  const moves = chess.history({ verbose: true }).map(move => ({
    san: move.san,
    uci: move.lan,
    color: move.color as Color,
    before: normalizeFen(move.before),
    after: normalizeFen(move.after),
  }));
  if (moves.length === 0) return null;
  const white = String(headers.White ?? '');
  const black = String(headers.Black ?? '');
  return {
    id: String(headers.Site ?? headers.Link ?? fallbackId),
    white,
    black,
    result: String(headers.Result ?? '*'),
    speed: inferSpeed(headers.TimeControl),
    pgn,
    moves,
  };
}

function splitPgn(pgn: string): string[] {
  const trimmed = pgn.trim();
  if (!trimmed) return [];
  const starts = [...trimmed.matchAll(/(?=^\s*\[Event\s+")/gm)].map(match => match.index ?? 0);
  if (starts.length <= 1) return [trimmed];
  return starts.map((start, idx) => trimmed.slice(start, starts[idx + 1] ?? trimmed.length).trim()).filter(Boolean);
}

function gameMatchesOptions(game: ParsedImportGame, options: ImportOptions): boolean {
  const username = normalizeImportUsername(options.username, options.source);
  if (username) {
    const sideName = options.side === 'w' ? game.white : game.black;
    if (sideName.trim().toLowerCase() !== username) return false;
  }
  return options.speeds.includes(game.speed as ImportSpeed);
}

function normalizeImportUsername(value: string, source: ImportSource): string {
  if (source === 'chesscom') return normalizeChessComUsername(value);
  if (source === 'lichess') return normalizeLichessUsername(value);
  return value.trim().replace(/^@/, '').toLowerCase();
}

function normalizeChessComUsername(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/chess\.com\/(?:member|player|stats|games)\/([^/?#\s]+)/i);
  const raw = match?.[1] ?? trimmed.replace(/^@/, '');
  return raw.trim().toLowerCase();
}

function normalizeLichessUsername(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/lichess\.org\/(?:@\/)?([^/?#\s]+)/i);
  const raw = match?.[1] ?? trimmed.replace(/^@/, '');
  return raw.trim().toLowerCase();
}

function findGamesAtRoot(games: ParsedImportGame[], opening: CuratedOpening): RootGame[] {
  const rootFen = openingFen(opening);
  const result: RootGame[] = [];
  for (const game of games) {
    const idx = game.moves.findIndex(move => move.after === rootFen);
    if (idx >= 0 && idx < game.moves.length - 1) result.push({ game, startIndex: idx });
  }
  return result;
}

function buildFenMoveStats(rootGames: RootGame[]): Map<NormFen, FenMoveStat[]> {
  const acc = new Map<NormFen, Map<string, FenMoveStat>>();
  for (const item of rootGames) {
    const continuation = item.game.moves.slice(item.startIndex + 1, item.startIndex + 1 + MAX_PLIES_AFTER_ROOT);
    for (const move of continuation) {
      let perPos = acc.get(move.before);
      if (!perPos) { perPos = new Map(); acc.set(move.before, perPos); }
      const existing = perPos.get(move.uci);
      if (existing) existing.games++;
      else perPos.set(move.uci, { uci: move.uci, san: move.san, games: 1, childFen: move.after });
    }
  }
  const result = new Map<NormFen, FenMoveStat[]>();
  for (const [fen, moves] of acc) {
    result.set(fen, [...moves.values()].sort((a, b) => b.games - a.games));
  }
  return result;
}

function buildRootTree(rootGames: RootGame[], opening: CuratedOpening): TreeNode {
  const root: TreeNode = { fen: openingFen(opening), incoming: null, games: rootGames.length, children: new Map() };
  for (const item of rootGames) {
    let cursor = root;
    const continuation = item.game.moves.slice(item.startIndex + 1, item.startIndex + 1 + MAX_PLIES_AFTER_ROOT);
    for (const move of continuation) {
      let child = cursor.children.get(move.uci);
      if (!child) {
        child = { fen: move.after, incoming: move, games: 0, children: new Map() };
        cursor.children.set(move.uci, child);
      }
      child.games++;
      cursor = child;
    }
  }
  return root;
}

async function synthesizeLines(input: {
  opening: CuratedOpening;
  node: TreeNode;
  path: string[];
  decisions: ImportDecision[];
  cpLossThreshold: number;
  playerDecisionCount: number;
  fenMoveStats: Map<NormFen, FenMoveStat[]>;
  playerDecisionsByFen: Map<NormFen, PlayerDecisionCache>;
  signal?: AbortSignal;
}): Promise<string[][]> {
  if (input.signal?.aborted) return [];
  if (input.node.children.size === 0 || input.playerDecisionCount >= MAX_PLAYER_DECISIONS_PER_ROOT) return [input.path];

  const turn = turnAt(input.node.fen);
  if (turn === input.opening.color) {
    let cached = input.playerDecisionsByFen.get(input.node.fen);
    if (!cached) {
      const choice = await choosePlayerContinuation(input.opening, input.node, input.cpLossThreshold, input.fenMoveStats, input.signal);
      if (!choice) return [input.path];
      input.decisions.push(choice.decision);
      cached = { kind: choice.kind, chosenUci: choice.decision.chosenUci, chosenSan: choice.decision.chosenSan };
      input.playerDecisionsByFen.set(input.node.fen, cached);
    }
    const nextPath = [...input.path, cached.chosenSan];
    if (cached.kind === 'replaced') return [nextPath];
    const chosenChild = input.node.children.get(cached.chosenUci);
    if (!chosenChild) return [nextPath];
    return synthesizeLines({
      ...input,
      node: chosenChild,
      path: nextPath,
      playerDecisionCount: input.playerDecisionCount + 1,
    });
  }

  const opponentChildren = chooseOpponentBranches(input.node);
  if (opponentChildren.length === 0) return [input.path];
  const lines: string[][] = [];
  for (const child of opponentChildren) {
    if (!child.incoming) continue;
    const childLines = await synthesizeLines({
      ...input,
      node: child,
      path: [...input.path, child.incoming.san],
    });
    lines.push(...childLines);
  }
  return lines;
}

async function choosePlayerContinuation(
  opening: CuratedOpening,
  node: TreeNode,
  cpLossThreshold: number,
  fenMoveStats: Map<NormFen, FenMoveStat[]>,
  signal?: AbortSignal
): Promise<{ kind: 'kept' | 'replaced'; decision: ImportDecision } | null> {
  const candidates = (fenMoveStats.get(node.fen) ?? []).slice(0, MAX_PLAYER_CANDIDATES);
  if (candidates.length === 0) return null;

  const qualities = [];
  for (const candidate of candidates) {
    qualities.push({
      candidate,
      quality: await evaluateCandidate(node.fen, candidate.uci, opening.color, cpLossThreshold, signal),
    });
  }

  const acceptable = qualities.filter(item => item.quality.acceptable);
  if (acceptable.length > 0) {
    acceptable.sort((a, b) => b.candidate.games - a.candidate.games || b.quality.score - a.quality.score);
    const winner = acceptable[0];
    const candidate = winner.candidate;
    return {
      kind: 'kept',
      decision: {
        id: `${opening.key}-${node.fen}-${candidate.uci}`,
        openingKey: opening.key,
        ply: pathPly(opening.moves, node.fen),
        fen: node.fen,
        kind: 'kept',
        playedSan: candidate.san,
        playedUci: candidate.uci,
        chosenSan: candidate.san,
        chosenUci: candidate.uci,
        games: candidate.games,
        masterGames: winner.quality.masterGames,
        cpLoss: winner.quality.cpLoss,
        reason: keepReason(winner.quality, candidate.games),
      },
    };
  }

  const mostCommon = qualities[0];
  const candidate = mostCommon.candidate;
  const replacement = await chooseReplacement(node.fen, opening.color, signal);
  if (!replacement) {
    return {
      kind: 'kept',
      decision: {
        id: `${opening.key}-${node.fen}-${candidate.uci}`,
        openingKey: opening.key,
        ply: pathPly(opening.moves, node.fen),
        fen: node.fen,
        kind: 'kept',
        playedSan: candidate.san,
        playedUci: candidate.uci,
        chosenSan: candidate.san,
        chosenUci: candidate.uci,
        games: candidate.games,
        masterGames: mostCommon.quality.masterGames,
        cpLoss: mostCommon.quality.cpLoss,
        reason: 'Kept because Chesski could not find a safe replacement from masters or engine data.',
      },
    };
  }

  return {
    kind: 'replaced',
    decision: {
      id: `${opening.key}-${node.fen}-${candidate.uci}-replacement`,
      openingKey: opening.key,
      ply: pathPly(opening.moves, node.fen),
      fen: node.fen,
      kind: 'replaced',
      playedSan: candidate.san,
      playedUci: candidate.uci,
      chosenSan: replacement.san,
      chosenUci: replacement.uci,
      games: candidate.games,
      masterGames: mostCommon.quality.masterGames,
      cpLoss: mostCommon.quality.cpLoss,
      reason: replacement.reason,
    },
  };
}

async function evaluateCandidate(
  fen: NormFen,
  uci: string,
  color: Color,
  cpLossThreshold: number,
  signal?: AbortSignal
): Promise<{ acceptable: boolean; cpLoss: number | null; masterGames: number; score: number }> {
  const [masters, evaluation] = await Promise.all([
    fetchMastersSafe(fen, signal),
    evaluateMoveCpLoss(fen, uci, signal),
  ]);
  const masterTotal = masters ? totalGames(masters) : 0;
  const masterMove = masters?.moves.find(move => move.uci === uci) ?? null;
  const masterGames = masterMove ? moveGames(masterMove) : 0;
  const cpLoss = evaluation.cpLoss;
  const noMasterPosition = masterTotal === 0;
  const acceptable = noMasterPosition
    ? cpLoss !== null && cpLoss <= NO_MASTER_CP_THRESHOLD
    : masterGames > 0 && (cpLoss === null || cpLoss <= cpLossThreshold);
  const score = (masterGames / Math.max(1, masterTotal)) * 100 + (cpLoss === null ? 0 : Math.max(0, cpLossThreshold - cpLoss));
  void color;
  return { acceptable, cpLoss, masterGames, score };
}

async function chooseReplacement(fen: NormFen, color: Color, signal?: AbortSignal): Promise<{ san: string; uci: string; reason: string } | null> {
  const masters = await fetchMastersSafe(fen, signal);
  const topMaster = masters?.moves.slice().sort((a, b) => moveGames(b) - moveGames(a))[0] ?? null;
  const engine = await evaluateMoveCpLoss(fen, topMaster?.uci ?? '0000', signal);
  if (engine.best) {
    return {
      san: engine.best.san,
      uci: engine.best.uci,
      reason: `Chesski's algorithm prefers this continuation because it is the engine's top move from this position${topMaster ? ' and the master database gives it a practical comparison point' : ''}.`,
    };
  }
  if (topMaster) {
    return {
      san: topMaster.san,
      uci: topMaster.uci,
      reason: `Chesski's algorithm prefers this continuation because it is the most common master move from this position.`,
    };
  }
  const legal = new Chess(`${fen} 0 1`).moves({ verbose: true })[0];
  if (!legal) return null;
  void color;
  return {
    san: legal.san,
    uci: legal.lan,
    reason: `Chesski's algorithm prefers this continuation because the original move failed the filters and no master or engine replacement was available.`,
  };
}

export interface ConflictMoveStats {
  uci: string;
  san: string;
  cpLoss: number | null;
  masterGames: number;
  wins: number;
  draws: number;
  losses: number;
  acceptable: boolean;
}

export interface ConflictResolution {
  /** 'existing' = keep the move already in the repertoire; 'new' = swap to the new move; 'modal' = ask user. */
  decision: 'existing' | 'new' | 'modal';
  reason: string;
  algorithmPickSan: string | null;
  existingStats: ConflictMoveStats;
  newStats: ConflictMoveStats;
}

const CONFLICT_MIN_MASTER_GAMES = 10;

/**
 * Resolves a conflict between two player moves at the same FEN.
 * Walks master moves by frequency, picks the first one passing engine + 10+ games + W>L for the player.
 * If the algorithm's pick matches one of the two user moves, that move wins automatically.
 * Otherwise, if both user moves are acceptable, returns 'modal'.
 */
export async function resolvePlayerConflict(
  fen: NormFen,
  color: Color,
  existingUci: string,
  newUci: string,
  cpLossThreshold: number,
  signal?: AbortSignal
): Promise<ConflictResolution> {
  const masters = await fetchMastersSafe(fen, signal);
  const masterMoves = masters?.moves
    .slice()
    .sort((a, b) => moveGames(b) - moveGames(a)) ?? [];

  // Find algorithm pick by walking master moves
  let algorithmPickUci: string | null = null;
  let algorithmPickSan: string | null = null;
  for (const m of masterMoves) {
    const games = moveGames(m);
    if (games < CONFLICT_MIN_MASTER_GAMES) continue;
    const wins = color === 'w' ? m.white : m.black;
    const losses = color === 'w' ? m.black : m.white;
    if (wins <= losses) continue;
    const engine = await evaluateMoveCpLoss(fen, m.uci, signal);
    const cpLoss = engine.cpLoss;
    if (cpLoss === null || cpLoss > cpLossThreshold) continue;
    algorithmPickUci = m.uci;
    algorithmPickSan = m.san;
    break;
  }

  // Build stats for both user moves
  const existingStats = await buildConflictStats(fen, color, existingUci, cpLossThreshold, masters, signal);
  const newStats = await buildConflictStats(fen, color, newUci, cpLossThreshold, masters, signal);

  if (algorithmPickUci === existingUci) {
    return {
      decision: 'existing',
      reason: `${existingStats.san} is the master-recommended move at this position (top master pick passing engine + ${CONFLICT_MIN_MASTER_GAMES}+ games + W>L).`,
      algorithmPickSan,
      existingStats,
      newStats,
    };
  }
  if (algorithmPickUci === newUci) {
    return {
      decision: 'new',
      reason: `${newStats.san} is the master-recommended move at this position (top master pick passing engine + ${CONFLICT_MIN_MASTER_GAMES}+ games + W>L).`,
      algorithmPickSan,
      existingStats,
      newStats,
    };
  }

  // Algorithm pick is neither user move (or none found)
  if (existingStats.acceptable && newStats.acceptable) {
    return {
      decision: 'modal',
      reason: 'Both moves are acceptable and neither matches the algorithm pick — user input required.',
      algorithmPickSan,
      existingStats,
      newStats,
    };
  }
  if (existingStats.acceptable) {
    return {
      decision: 'existing',
      reason: `${newStats.san} fails the engine/master filters; keeping ${existingStats.san}.`,
      algorithmPickSan,
      existingStats,
      newStats,
    };
  }
  if (newStats.acceptable) {
    return {
      decision: 'new',
      reason: `${existingStats.san} fails the engine/master filters; switching to ${newStats.san}.`,
      algorithmPickSan,
      existingStats,
      newStats,
    };
  }
  return {
    decision: 'modal',
    reason: 'Neither move passes the filters cleanly — user input required.',
    algorithmPickSan,
    existingStats,
    newStats,
  };
}

async function buildConflictStats(
  fen: NormFen,
  color: Color,
  uci: string,
  cpLossThreshold: number,
  masters: LichessExplorerResponse | null,
  signal?: AbortSignal
): Promise<ConflictMoveStats> {
  const masterMove = masters?.moves.find(m => m.uci === uci) ?? null;
  const masterGames = masterMove ? moveGames(masterMove) : 0;
  const wins = masterMove ? (color === 'w' ? masterMove.white : masterMove.black) : 0;
  const losses = masterMove ? (color === 'w' ? masterMove.black : masterMove.white) : 0;
  const draws = masterMove ? masterMove.draws : 0;
  const engine = await evaluateMoveCpLoss(fen, uci, signal);
  const cpLoss = engine.cpLoss;
  const masterTotal = masters ? totalGames(masters) : 0;
  const noMasterPosition = masterTotal === 0;
  const acceptable = noMasterPosition
    ? cpLoss !== null && cpLoss <= NO_MASTER_CP_THRESHOLD
    : masterGames > 0 && (cpLoss === null || cpLoss <= cpLossThreshold);
  const san = masterMove?.san ?? uciToSan(fen, uci) ?? uci;
  return { uci, san, cpLoss, masterGames, wins, draws, losses, acceptable };
}

function uciToSan(fen: NormFen, uci: string): string | null {
  try {
    const chess = new Chess(`${fen} 0 1`);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const move = chess.move({ from, to, promotion });
    return move?.san ?? null;
  } catch {
    return null;
  }
}

function chooseOpponentBranches(node: TreeNode): TreeNode[] {
  const children = [...node.children.values()].sort((a, b) => b.games - a.games);
  const total = children.reduce((sum, child) => sum + child.games, 0);
  return children
    .filter((child, idx) => idx === 0 || child.games / Math.max(1, total) >= MIN_OPPONENT_FRACTION || child.games >= 2)
    .slice(0, MAX_OPPONENT_BRANCHES);
}

async function fetchMastersSafe(fen: NormFen, signal?: AbortSignal): Promise<LichessExplorerResponse | null> {
  try {
    return await fetchExplorer(fen, { source: 'masters' }, signal);
  } catch {
    return null;
  }
}

function openingFen(opening: CuratedOpening): NormFen {
  let fen = STARTING_FEN_NORM;
  for (const move of opening.moves) {
    const result = applyMove(fen, move);
    if (!result) return fen;
    fen = result.fen;
  }
  return fen;
}

function uniqueLines(lines: string[][]): string[][] {
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const line of lines) {
    const key = line.join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }
  return result;
}

function keepReason(quality: { cpLoss: number | null; masterGames: number }, games: number): string {
  if (quality.masterGames > 0 && quality.cpLoss !== null) {
    return `Kept because you played it in ${games} game${games === 1 ? '' : 's'}, it has master support, and its loss is ${Math.round(quality.cpLoss)} cp.`;
  }
  if (quality.masterGames > 0) return `Kept because you played it in ${games} game${games === 1 ? '' : 's'} and it has master support.`;
  if (quality.cpLoss !== null) return `Kept because the master database had no games here and the move loses only ${Math.round(quality.cpLoss)} cp.`;
  return `Kept because it was your most common supported continuation.`;
}

function pathPly(openingMoves: string[], fen: NormFen): number {
  void fen;
  return openingMoves.length + 1;
}

function totalGames(response: LichessExplorerResponse): number {
  return response.white + response.draws + response.black;
}

function moveGames(move: { white: number; draws: number; black: number }): number {
  return move.white + move.draws + move.black;
}

function chessComSpeed(value?: string): ImportSpeed | 'other' | null {
  if (value === 'bullet' || value === 'blitz' || value === 'rapid') return value;
  return value ? 'other' : null;
}

function inferSpeed(timeControl: unknown): ImportSpeed | 'other' {
  const raw = String(timeControl ?? '');
  const base = Number(raw.split('+')[0]);
  if (!Number.isFinite(base)) return 'other';
  if (base < 180) return 'bullet';
  if (base < 600) return 'blitz';
  if (base < 1800) return 'rapid';
  return 'other';
}

function lichessSpeedFromHeaders(pgn: string): ImportSpeed | 'other' | null {
  const match = pgn.match(/^\[Event\s+"([^"]+)"/m);
  const event = match?.[1].toLowerCase() ?? '';
  if (event.includes('bullet')) return 'bullet';
  if (event.includes('blitz')) return 'blitz';
  if (event.includes('rapid')) return 'rapid';
  return null;
}

function sideName(side: Color): string {
  return side === 'w' ? 'White' : 'Black';
}

function speedLabel(speeds: ImportSpeed[]): string {
  return speeds.join('/');
}
