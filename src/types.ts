export type NormFen = string;
export type Color = 'w' | 'b';

// A repertoire is owned by a single color. Same FEN can appear in multiple repertoires
// with independent edges and SRS state.
export interface Repertoire {
  id: string;
  name: string;
  color: Color;
  // Where this preparation tree begins. Standard repertoires should normally
  // use the absolute starting position so they can hold many opening branches.
  rootFen: NormFen;
  // Curated opening this repertoire was created from (for display/provenance only).
  openingKey: string | null;
  folderId?: string | null;
  // Internal storage name kept for old data: "siloed" means a separate repertoire that
  // can intentionally contradict another repertoire from the same position.
  projectKind?: 'standard' | 'siloed';
  archived?: boolean;
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
  color?: Color;
  openingKey?: string | null;
  openingName?: string | null;
  scopeKey?: string;
  rootFen?: NormFen;
  startFen?: NormFen;
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

// A pre-built training line cached in IndexedDB so the next Train click can serve
// it instantly. The build worker fills the cache up to a per-scope cap. Edges are
// stored as IDs and rehydrated from the `edges` store on consumption, so the user
// always sees fresh SRS state.
export interface ReadyLine {
  id: string;
  repertoireId: string;
  scopeKey: string;
  fullPathEdgeIds: string[];
  newEdgeIds: string[];
  generationStartIndex: number;
  frontierId?: string;
  frontierFen?: NormFen;
  // Cached for the queue UI so we don't have to rehydrate just to render a row.
  startFen: NormFen;
  endFen: NormFen;
  qualityDropCp: number | null;
  // Pre-rendered SAN preview (e.g. "1.e4 Nf6 2.e5 Nd5 ...") so the queue panel
  // can show the line without hitting the edges store.
  previewSan: string;
  createdAt: string;
}

// Pointer to a single review-segment the user was midway through when they hit
// "End session". SRS damage to its cards has already been rolled back; this
// record only tells the next line-aware review session to re-offer that exact
// segment first. Keyed by (repertoireId, scopeKey) so each scope holds at most
// one pending segment. Ignored by flat (non-line-aware) review.
export interface PendingPartialLine {
  id: string;
  repertoireId: string;
  scopeKey: string;
  segmentRootFen: NormFen;
  pathEdgeIds: string[];
  promptEdgeIds: string[];
  originalSegmentIdx: number;
  contextPlyIdxAtEnd: number;
  createdAt: string;
}

export function pendingPartialLineId(repertoireId: string, scopeKey: string): string {
  return `${repertoireId}::${scopeKey}`;
}

export function edgeId(repertoireId: string, parentFen: NormFen, childFen: NormFen): string {
  return `${repertoireId}::${parentFen}::${childFen}`;
}

export function frontierId(repertoireId: string, parentFen: NormFen, uci: string): string {
  return `${repertoireId}::${parentFen}::${uci}`;
}

export function readyLineId(repertoireId: string, scopeKey: string): string {
  return `${repertoireId}::${scopeKey}::${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newId(prefix = 'rep'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
