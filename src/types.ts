export type NormFen = string;
export type Color = 'w' | 'b';

// A repertoire is owned by a single color. Same FEN can appear in multiple repertoires
// with independent edges and SRS state.
export interface Repertoire {
  id: string;
  name: string;
  color: Color;
  // Where this repertoire begins. Usually the absolute starting position; could be a deeper
  // anchor for variant-specific repertoires later.
  rootFen: NormFen;
  // Curated opening this repertoire was created from (for display).
  openingKey: string | null;
  folderId?: string | null;
  // Internal storage name kept for old data: "siloed" means a separate repertoire that
  // can intentionally contradict the main repertoire from the same position.
  projectKind?: 'standard' | 'siloed';
  createdAt: string;
  updatedAt?: string;
}

// A position keyed by normalized FEN. Globally shared across repertoires.
// We keep `createdAt` as the only payload; parents/children are derived from edges.
export interface PositionNode {
  fen: NormFen;
  createdAt: string;
}

// An edge belongs to a repertoire. SRS state lives here.
// Only edges where `mover === repertoire.color` are presented as cards in Train mode.
// Opponent-color edges are scaffolding (navigable but not tested).
export interface Edge {
  id: string;
  repertoireId: string;
  parentFen: NormFen;
  childFen: NormFen;
  san: string;
  uci: string;
  mover: Color;
  // SM-2 state (only meaningful when mover === repertoire.color).
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  dueAt: string;
  lastReviewedAt: string | null;
  // "Crushing" tag — opponent move significantly worse than best per engine.
  isMistake?: boolean;
  recommendationSource?: 'player-book';
  sourcePlayerName?: string;
  sourceGameName?: string;
  sourceWins?: number;
  sourceDraws?: number;
  sourceLosses?: number;
  sourceNet?: number;
  // Scaffolding edges let a repertoire reach a core opening position without
  // turning the lead-in into trainable "your move" cards.
  isScaffold?: boolean;
  createdAt: string;
}

export type FrontierStatus = 'open' | 'answered' | 'blocked' | 'stale';
export type FrontierSource = 'explorer' | 'stockfish' | 'stored';

export interface FrontierPathStep {
  fromFen: NormFen;
  toFen: NormFen;
  san: string;
  uci: string;
  mover: Color;
  popularityFraction: number;
  edgeId?: string | null;
}

export interface FrontierCandidate {
  id: string;
  repertoireId: string;
  parentFen: NormFen;
  childFen: NormFen;
  san: string;
  uci: string;
  mover: Color;
  path: FrontierPathStep[];
  weight: number;
  games: number;
  popularityFraction: number;
  source: FrontierSource;
  status: FrontierStatus;
  lastReason?: string;
  createdAt: string;
  updatedAt: string;
}

export function edgeId(repertoireId: string, parentFen: NormFen, childFen: NormFen): string {
  return `${repertoireId}::${parentFen}::${childFen}`;
}

export function frontierId(repertoireId: string, parentFen: NormFen, uci: string): string {
  return `${repertoireId}::${parentFen}::${uci}`;
}

export function newId(prefix = 'rep'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
