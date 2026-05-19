import { denormalizeFen } from './chess';
import { getMeta, setMeta } from './storage';
import { getPersistentLichessToken, setPersistentLichessToken } from './localVault';
import type { NormFen } from '../types';

export interface LichessMove {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number;
}

export interface LichessExplorerResponse {
  white: number;
  draws: number;
  black: number;
  moves: LichessMove[];
}

// Cloud-eval response shape (lichess.org/api/cloud-eval).
export interface CloudEvalPv {
  // cp may be missing if the line is forced mate (mate field present instead).
  cp?: number;
  mate?: number;
  // Space-separated UCI moves. moves[0] is the engine's choice in this PV.
  moves: string;
  // Win/Draw/Loss probabilities from the side-to-move's perspective, per-mille
  // (each value 0–1000, summing to 1000). Emitted by local Stockfish when
  // UCI_ShowWDL is enabled. Lichess cloud-eval does not provide WDL today, so
  // this is undefined when the eval came from the cloud fallback.
  wdl?: { win: number; draw: number; loss: number };
}
export interface CloudEvalResponse {
  fen: string;
  knodes: number;
  depth: number;
  pvs: CloudEvalPv[];
}

export class LichessAuthError extends Error {
  constructor(msg: string) { super(msg); this.name = 'LichessAuthError'; }
}

const META_TOKEN_KEY = 'lichess_token';
const explorerCache = new Map<string, LichessExplorerResponse>();
const evalCache = new Map<NormFen, CloudEvalResponse | null>();
const localEvalCache = new Map<string, CloudEvalResponse | null>();
let _tokenCache: string | null | undefined = undefined;

export async function getLichessToken(): Promise<string | null> {
  if (_tokenCache !== undefined) return _tokenCache;
  const durableToken = await getPersistentLichessToken();
  if (durableToken !== undefined) {
    _tokenCache = durableToken;
    if (durableToken) await setMeta(META_TOKEN_KEY, durableToken);
    return _tokenCache;
  }
  const t = await getMeta<string>(META_TOKEN_KEY);
  _tokenCache = t ?? null;
  return _tokenCache;
}

export async function setLichessToken(token: string | null): Promise<void> {
  _tokenCache = token;
  await setPersistentLichessToken(token);
  await setMeta(META_TOKEN_KEY, token);
}

export async function validateLichessToken(token: string, signal?: AbortSignal): Promise<void> {
  const params = new URLSearchParams({
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    speeds: 'rapid,classical',
    ratings: '1600,1800,2000',
  });
  let res: Response;
  try {
    res = await fetch(`https://explorer.lichess.ovh/lichess?${params.toString()}`, {
      signal,
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error('Could not reach Lichess from this browser. Try a hard refresh, then try again.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new LichessAuthError(`Lichess rejected this token (${res.status}). Create a fresh token and paste the full lip_ value.`);
  }
  if (!res.ok) throw new Error(`Lichess token check failed (${res.status}). Try again in a moment.`);
}

export interface ExplorerQueryOptions {
  source: 'lichess' | 'masters';
  // Only used for source === 'lichess'.
  speeds?: string;
  ratings?: string;
}

export async function fetchExplorer(normFen: NormFen, opts: ExplorerQueryOptions, signal?: AbortSignal): Promise<LichessExplorerResponse> {
  const cacheKey = JSON.stringify({ fen: normFen, opts });
  const cached = explorerCache.get(cacheKey);
  if (cached) return cached;
  const token = await getLichessToken();
  if (!token) throw new LichessAuthError('No Lichess token set.');
  const fen = denormalizeFen(normFen);
  const params = new URLSearchParams({ fen });
  if (opts.source === 'lichess') {
    params.set('speeds', opts.speeds ?? 'blitz,rapid,classical');
    params.set('ratings', opts.ratings ?? '1600,1800,2000,2200,2500');
  }
  const url = `https://explorer.lichess.ovh/${opts.source}?${params.toString()}`;
  const res = await fetch(url, { signal, headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    throw new LichessAuthError(`Lichess rejected the token (${res.status}). It may be invalid or revoked.`);
  }
  if (!res.ok) throw new Error(`Lichess explorer ${res.status}`);
  const data = (await res.json()) as LichessExplorerResponse;
  explorerCache.set(cacheKey, data);
  return data;
}

// Convenience: original "general players" view (used by the LichessPanel UI).
export async function fetchExplorerDefault(normFen: NormFen, signal?: AbortSignal): Promise<LichessExplorerResponse> {
  return fetchExplorer(normFen, { source: 'lichess' }, signal);
}

// Cloud-eval. Returns null if Lichess has no analyzed result for this position (404).
// No token required.
// `depth` only affects the local Stockfish path (Lichess cloud-eval has no depth param —
// it serves whatever's cached). Local SF cache key includes depth so different depths
// don't share results.
export async function fetchCloudEval(normFen: NormFen, multiPv = 5, depth?: number, signal?: AbortSignal): Promise<CloudEvalResponse | null> {
  const local = await fetchLocalStockfishEval(normFen, multiPv, depth, signal);
  if (local) return local;

  const cached = evalCache.get(normFen);
  if (cached !== undefined) return cached;
  const fen = denormalizeFen(normFen);
  const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`;
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch {
    return null;
  }
  if (res.status === 404) {
    evalCache.set(normFen, null);
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json()) as CloudEvalResponse;
  evalCache.set(normFen, data);
  return data;
}

// Local-Stockfish-only eval. Use this for any decision that depends on a specific depth
// (user-move picking, the quality gate, mistake-tagging during line construction).
// Never falls through to Lichess cloud-eval — Lichess ignores the depth argument and
// returns whatever is cached, which silently degrades depth-sensitive callers.
// Returns null when local Stockfish is unavailable; callers should surface that.
export async function fetchLocalEval(normFen: NormFen, multiPv = 5, depth?: number, signal?: AbortSignal): Promise<CloudEvalResponse | null> {
  return fetchLocalStockfishEval(normFen, multiPv, depth, signal);
}

async function fetchLocalStockfishEval(normFen: NormFen, multiPv = 5, depth?: number, signal?: AbortSignal): Promise<CloudEvalResponse | null> {
  const cacheKey = JSON.stringify({ fen: normFen, multiPv, depth: depth ?? null });
  const cached = localEvalCache.get(cacheKey);
  // Only positive results are cached — failures (timeout, abort, non-OK, empty PVs)
  // are retried every call so transient hiccups don't permanently poison a position.
  if (cached) return cached;
  let res: Response;
  try {
    res = await fetch('/api/stockfish/eval', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(depth !== undefined ? { fen: normFen, multiPv, depth } : { fen: normFen, multiPv }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json()) as CloudEvalResponse;
  if (!data.pvs?.length) return null;
  localEvalCache.set(cacheKey, data);
  return data;
}

export function clearLichessCache(): void {
  explorerCache.clear();
  evalCache.clear();
  localEvalCache.clear();
}
