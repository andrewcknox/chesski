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
  createdAt: string;
}

export function edgeId(repertoireId: string, parentFen: NormFen, childFen: NormFen): string {
  return `${repertoireId}::${parentFen}::${childFen}`;
}

export function newId(prefix = 'rep'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
