import { Chess } from 'chess.js';
import type { Color, NormFen } from '../types';
import { normalizeFen } from './chess';
import type { PlayerKey } from './recommendationSettings';
import { getMeta, setMeta } from './storage';

interface BookCandidate {
  san: string;
  uci: string;
  wins: number;
  draws: number;
  losses: number;
  scoreRate?: number;
  examples?: string[];
  winExamples?: string[];
  drawExamples?: string[];
  lossExamples?: string[];
  sourceLine?: PlayerBookSourceLine;
}

interface MutableBookCandidate extends BookCandidate {
  winExamples: string[];
  drawExamples: string[];
  lossExamples: string[];
  sourceLineRank?: number;
}

export interface PlayerBookSourceMove {
  san: string;
  uci: string;
  color: Color;
}

export interface PlayerBookSourceLine {
  label: string;
  moves: PlayerBookSourceMove[];
}

interface PlayerBookJson {
  key: PlayerKey;
  name: string;
  games: number;
  sampledGames?: number;
  parsedGames: number;
  indexedGames: number;
  positions: number;
  entries: [string, BookCandidate[]][];
}

interface PlayerBooksJson {
  generatedAt: string;
  maxOpeningPlies: number;
  maxGamesPerPlayer?: number;
  players: PlayerBookJson[];
}

interface LoadedBooks {
  players: Map<PlayerKey, LoadedPlayerBook>;
}

interface LoadedPlayerBook {
  key: PlayerKey;
  name: string;
  games: number;
  indexedGames: number;
  positions: number;
  byColorFen: Map<string, BookCandidate[]>;
}

export interface PlayerBookPick {
  san: string;
  uci: string;
  playerKey: PlayerKey;
  playerName: string;
  wins: number;
  draws: number;
  losses: number;
  net: number;
  scoreRate: number;
  sourceGameName: string | null;
  sourceLine?: PlayerBookSourceLine;
}

export interface PlayerBookStats {
  key: PlayerKey;
  name: string;
  games: number;
  indexedGames: number;
  positions: number;
}

interface StoredUserBook {
  key: 'self';
  name: string;
  matchName: string;
  importedAt: string;
  games: number;
  parsedGames: number;
  indexedGames: number;
  positions: number;
  entries: [string, BookCandidate[]][];
}

const PLAYER_BOOK_URL = '/players/player-books.json';
const META_USER_PLAYER_BOOK = 'user_player_book_v1';
const MAX_IMPORT_PLIES = 24;
let booksPromise: Promise<LoadedBooks> | null = null;

function colorFenKey(color: Color, fen: NormFen): string {
  return `${color}::${fen}`;
}

export async function pickPlayerBookMove(playerKey: PlayerKey, fen: NormFen, color: Color, signal?: AbortSignal): Promise<PlayerBookPick | null> {
  return (await getPlayerBookMoves(playerKey, fen, color, signal))[0] ?? null;
}

export async function getPlayerBookMoves(playerKey: PlayerKey, fen: NormFen, color: Color, signal?: AbortSignal): Promise<PlayerBookPick[]> {
  const book = playerKey === 'self' ? await loadUserBook() : (await loadPlayerBooks(signal)).players.get(playerKey);
  if (!book) return [];
  const candidates = book.byColorFen.get(colorFenKey(color, fen));
  if (!candidates || candidates.length === 0) return [];
  const viable = candidates.filter(isCandidateTakeable);
  if (viable.length === 0) return [];
  return [...viable].sort(compareCandidates).map(candidate => ({
    ...candidate,
    playerKey,
    playerName: book.name,
    net: candidate.wins - candidate.losses,
    scoreRate: resultScoreRate(candidate),
    sourceGameName: candidate.winExamples?.[0] ?? candidate.examples?.[0] ?? null,
    sourceLine: candidate.sourceLine,
  }));
}

export interface PlayerBookLookup {
  bookFound: boolean;
  playerName: string | null;
  positionKey: string;
  rawCandidates: PlayerBookPick[];
}

// Raw lookup used by the picker so it can stage filters and trace per-stage
// rejections. Same source as `getPlayerBookMoves` but without the
// `isCandidateTakeable` (W>L) filter and without the `compareCandidates` sort.
// Candidates are returned in natural book-storage order so the trace shows
// each move as the picker considered it.
export async function getPlayerBookCandidatesRaw(
  playerKey: PlayerKey,
  fen: NormFen,
  color: Color,
  signal?: AbortSignal,
): Promise<PlayerBookLookup> {
  const positionKey = colorFenKey(color, fen);
  const book = playerKey === 'self' ? await loadUserBook() : (await loadPlayerBooks(signal)).players.get(playerKey);
  if (!book) return { bookFound: false, playerName: null, positionKey, rawCandidates: [] };
  const candidates = book.byColorFen.get(positionKey);
  const rawCandidates = (candidates ?? []).map(candidate => ({
    ...candidate,
    playerKey,
    playerName: book.name,
    net: candidate.wins - candidate.losses,
    scoreRate: resultScoreRate(candidate),
    sourceGameName: candidate.winExamples?.[0] ?? candidate.examples?.[0] ?? null,
    sourceLine: candidate.sourceLine,
  }));
  return { bookFound: true, playerName: book.name, positionKey, rawCandidates };
}

export function isPlayerBookCandidateTakeable(candidate: Pick<PlayerBookPick, 'wins' | 'losses'>): boolean {
  return candidate.wins > candidate.losses;
}

export function comparePlayerBookCandidates(a: PlayerBookPick, b: PlayerBookPick): number {
  return compareCandidates(a, b);
}

export async function getPlayerBookStats(signal?: AbortSignal): Promise<PlayerBookStats[]> {
  const user = await loadUserBook();
  const builtIns = await loadPlayerBooks(signal);
  const players = [...(user ? [user] : []), ...Array.from(builtIns.players.values())];
  return players.map(player => ({
    key: player.key,
    name: player.name,
    games: player.games,
    indexedGames: player.indexedGames,
    positions: player.positions,
  }));
}

export async function getUserPlayerBookStats(): Promise<PlayerBookStats | null> {
  const user = await loadUserBook();
  return user ? {
    key: user.key,
    name: user.name,
    games: user.games,
    indexedGames: user.indexedGames,
    positions: user.positions,
  } : null;
}

export async function importUserPlayerBookFromPgn(pgn: string, matchName: string): Promise<PlayerBookStats> {
  const cleanName = matchName.trim();
  if (!cleanName) throw new Error('Enter the player name exactly as it appears in the PGN.');
  const book = buildBookFromPgn(pgn, cleanName);
  await setMeta(META_USER_PLAYER_BOOK, book);
  return {
    key: book.key,
    name: book.name,
    games: book.games,
    indexedGames: book.indexedGames,
    positions: book.positions,
  };
}

export async function clearUserPlayerBook(): Promise<void> {
  await setMeta(META_USER_PLAYER_BOOK, null);
}

async function loadUserBook(): Promise<LoadedPlayerBook | null> {
  const stored = await getMeta<StoredUserBook | null>(META_USER_PLAYER_BOOK);
  if (!stored) return null;
  return {
    key: 'self',
    name: stored.name,
    games: stored.games,
    indexedGames: stored.indexedGames,
    positions: stored.positions,
    byColorFen: new Map(stored.entries),
  };
}

async function loadPlayerBooks(signal?: AbortSignal): Promise<LoadedBooks> {
  if (booksPromise) return booksPromise;
  booksPromise = (async () => {
    const res = await fetch(PLAYER_BOOK_URL, { signal });
    if (!res.ok) throw new Error(`Could not load player books (${res.status}).`);
    const json = (await res.json()) as PlayerBooksJson;
    const players = new Map<PlayerKey, LoadedPlayerBook>();
    for (const player of json.players) {
      players.set(player.key, {
        key: player.key,
        name: player.name,
        games: player.games,
        indexedGames: player.indexedGames,
        positions: player.positions,
        byColorFen: new Map(player.entries),
      });
    }
    return { players } as LoadedBooks;
  })();
  return booksPromise;
}

function buildBookFromPgn(pgn: string, matchName: string): StoredUserBook {
  const games = splitGames(pgn);
  const positions = new Map<string, Map<string, MutableBookCandidate>>();
  const matcher = new RegExp(escapeRegExp(matchName), 'i');
  let parsedGames = 0;
  let indexedGames = 0;

  for (const game of games) {
    const chess = new Chess();
    try {
      chess.loadPgn(game, { strict: false });
    } catch {
      continue;
    }
    parsedGames++;
    const headers = chess.header();
    const white = String(headers.White ?? '');
    const black = String(headers.Black ?? '');
    const result = String(headers.Result ?? '');
    const color: Color | null = matcher.test(white) ? 'w' : matcher.test(black) ? 'b' : null;
    if (!color) continue;
    const bucket = resultForColor(result, color);
    if (!bucket) continue;
    indexedGames++;
    const label = gameLabel(headers);

    const moves = chess.history({ verbose: true }).slice(0, MAX_IMPORT_PLIES);
    for (const [idx, move] of moves.entries()) {
      if (move.color !== color) continue;
      const key = colorFenKey(color, normalizeFen(move.before));
      let byMove = positions.get(key);
      if (!byMove) {
        byMove = new Map();
        positions.set(key, byMove);
      }
      let stats = byMove.get(move.lan);
      if (!stats) {
        stats = { san: move.san, uci: move.lan, wins: 0, draws: 0, losses: 0, winExamples: [], drawExamples: [], lossExamples: [] };
        byMove.set(move.lan, stats);
      }
      stats[bucket]++;
      const examples = bucket === 'wins' ? stats.winExamples : bucket === 'draws' ? stats.drawExamples : stats.lossExamples;
      if (examples.length < 3 && !examples.includes(label)) examples.push(label);
      const rank = bucketRank(bucket);
      if (!stats.sourceLine || rank > (stats.sourceLineRank ?? 0)) {
        stats.sourceLine = sourceLineFromMoves(label, moves, idx);
        stats.sourceLineRank = rank;
      }
    }
  }

  const entries: [string, BookCandidate[]][] = [];
  for (const [key, byMove] of positions) {
    const moves = Array.from(byMove.values())
      .filter(isCandidateTakeable)
      .sort(compareCandidates)
      .map(({ sourceLineRank, ...m }) => ({ ...m, scoreRate: resultScoreRate(m) }));
    if (moves.length > 0) entries.push([key, moves]);
  }

  return {
    key: 'self',
    name: `My games (${matchName})`,
    matchName,
    importedAt: new Date().toISOString(),
    games: games.length,
    parsedGames,
    indexedGames,
    positions: entries.length,
    entries,
  };
}

function sourceLineFromMoves(label: string, moves: Array<{ san: string; lan: string; color: Color }>, startIndex: number): PlayerBookSourceLine {
  return {
    label,
    moves: moves.slice(startIndex, startIndex + 10).map(move => ({
      san: move.san,
      uci: move.lan,
      color: move.color,
    })),
  };
}

function bucketRank(bucket: 'wins' | 'draws' | 'losses'): number {
  if (bucket === 'wins') return 3;
  if (bucket === 'draws') return 2;
  return 1;
}

function splitGames(pgn: string): string[] {
  return pgn.split(/\r?\n(?=\[Event )/).map(g => g.trim()).filter(Boolean);
}

function resultForColor(result: string, color: Color): 'wins' | 'draws' | 'losses' | null {
  if (result === '1/2-1/2') return 'draws';
  if (color === 'w') return result === '1-0' ? 'wins' : result === '0-1' ? 'losses' : null;
  return result === '0-1' ? 'wins' : result === '1-0' ? 'losses' : null;
}

function gameLabel(headers: Record<string, string | null | undefined>): string {
  const white = String(headers.White || 'White').trim();
  const black = String(headers.Black || 'Black').trim();
  const event = String(headers.Event || '').trim();
  const site = String(headers.Site || '').trim();
  const date = String(headers.Date || '').trim();
  const result = String(headers.Result || '').trim();
  const place = [event, site].filter(Boolean).join(', ');
  const suffix = [place, date].filter(Boolean).join(' - ');
  return `${white} vs ${black}${result ? ` ${result}` : ''}${suffix ? ` (${suffix})` : ''}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function candidateGames(candidate: Pick<BookCandidate, 'wins' | 'draws' | 'losses'>): number {
  return candidate.wins + candidate.draws + candidate.losses;
}

function resultScoreRate(candidate: Pick<BookCandidate, 'wins' | 'draws' | 'losses'>): number {
  const n = candidateGames(candidate);
  if (n <= 0) return 0;
  return (candidate.wins + candidate.draws * 0.5) / n;
}

function isCandidateTakeable(candidate: Pick<BookCandidate, 'wins' | 'draws' | 'losses'>): boolean {
  return candidate.wins > candidate.losses;
}

function compareCandidates(a: BookCandidate, b: BookCandidate): number {
  const netDelta = (b.wins - b.losses) - (a.wins - a.losses);
  if (netDelta !== 0) return netDelta;
  const scoreDelta = resultScoreRate(b) - resultScoreRate(a);
  if (scoreDelta !== 0) return scoreDelta;
  if (b.wins !== a.wins) return b.wins - a.wins;
  const gamesDelta = candidateGames(b) - candidateGames(a);
  if (gamesDelta !== 0) return gamesDelta;
  return b.draws - a.draws;
}
