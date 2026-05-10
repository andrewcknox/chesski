import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { Chess } from 'chess.js';
import type { Color, Edge, FrontierCandidate, FrontierStatus, NormFen, PositionNode, Repertoire } from '../types';
import { edgeId, newId } from '../types';
import { applyMove, computeOpeningFen, normalizeFen, STARTING_FEN_NORM } from './chess';
import { freshSrsState } from './srs';
import { CURATED_OPENINGS, findOpening, type ResolvedOpeningLine } from './openings';

interface ChessTrainerDB extends DBSchema {
  repertoires: {
    key: string;
    value: Repertoire;
  };
  nodes: {
    key: string;
    value: PositionNode;
  };
  edges: {
    key: string;
    value: Edge;
    indexes: {
      'by-repertoire': string;
      'by-rep-parent': [string, string];
      'by-rep-child': [string, string];
      'by-rep-mover': [string, string];
    };
  };
  meta: {
    key: string;
    value: { key: string; value: unknown };
  };
  frontiers: {
    key: string;
    value: FrontierCandidate;
    indexes: {
      'by-repertoire': string;
      'by-rep-status': [string, FrontierStatus];
      'by-rep-child': [string, string];
    };
  };
}

const DB_NAME = 'chess-trainer';
// Version 2: per-repertoire edge model. Bumping wipes old (incompatible) data.
// Version 3: local frontier queue. Existing v2 data is preserved.
const DB_VERSION = 3;

let _dbPromise: Promise<IDBPDatabase<ChessTrainerDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<ChessTrainerDB>> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = openDB<ChessTrainerDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // For any old version, drop and recreate. The v1 schema's edges have no
      // repertoireId so they can't be migrated cleanly.
      if (oldVersion < 2) {
        for (const name of Array.from(db.objectStoreNames)) {
          db.deleteObjectStore(name);
        }
      }
      if (!db.objectStoreNames.contains('repertoires')) {
        db.createObjectStore('repertoires', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('nodes')) {
        db.createObjectStore('nodes', { keyPath: 'fen' });
      }
      if (!db.objectStoreNames.contains('edges')) {
        const edges = db.createObjectStore('edges', { keyPath: 'id' });
        edges.createIndex('by-repertoire', 'repertoireId');
        edges.createIndex('by-rep-parent', ['repertoireId', 'parentFen']);
        edges.createIndex('by-rep-child', ['repertoireId', 'childFen']);
        edges.createIndex('by-rep-mover', ['repertoireId', 'mover']);
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('frontiers')) {
        const frontiers = db.createObjectStore('frontiers', { keyPath: 'id' });
        frontiers.createIndex('by-repertoire', 'repertoireId');
        frontiers.createIndex('by-rep-status', ['repertoireId', 'status']);
        frontiers.createIndex('by-rep-child', ['repertoireId', 'childFen']);
      }
    },
  });
  return _dbPromise;
}

// ---------- Repertoires ----------

export async function listRepertoires(): Promise<Repertoire[]> {
  const db = await getDB();
  const all = await db.getAll('repertoires');
  all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return all;
}

export async function getRepertoire(id: string): Promise<Repertoire | undefined> {
  const db = await getDB();
  return db.get('repertoires', id);
}

export async function updateRepertoire(id: string, patch: Partial<Pick<Repertoire, 'name' | 'folderId' | 'projectKind'>>): Promise<Repertoire> {
  const db = await getDB();
  const existing = await db.get('repertoires', id);
  if (!existing) throw new Error('Could not find that repertoire.');
  const updated: Repertoire = {
    ...existing,
    ...patch,
    name: patch.name?.trim() || existing.name,
    updatedAt: new Date().toISOString(),
  };
  await db.put('repertoires', updated);
  return updated;
}

export async function deleteRepertoire(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['repertoires', 'edges', 'frontiers'], 'readwrite');
  await tx.objectStore('repertoires').delete(id);
  // Delete all edges scoped to this repertoire.
  const edgeStore = tx.objectStore('edges');
  const idx = edgeStore.index('by-repertoire');
  let cur = await idx.openCursor(IDBKeyRange.only(id));
  while (cur) {
    await cur.delete();
    cur = await cur.continue();
  }
  const frontierStore = tx.objectStore('frontiers');
  const frontierIdx = frontierStore.index('by-repertoire');
  let frontierCur = await frontierIdx.openCursor(IDBKeyRange.only(id));
  while (frontierCur) {
    await frontierCur.delete();
    frontierCur = await frontierCur.continue();
  }
  await tx.done;
  // Note: shared PositionNodes are not garbage-collected here — they're cheap and may be
  // referenced by other repertoires.
}

export interface CreateRepertoireOptions {
  name: string;
  color: Color;
  rootFen?: NormFen;
  openingKey?: string | null;
  moves?: string[];
  scaffoldPlyCount?: number;
  projectKind?: Repertoire['projectKind'];
}

const DEFAULT_MAIN_REPERTOIRES: Array<Pick<CreateRepertoireOptions, 'name' | 'color' | 'projectKind'>> = [
  { name: 'White Main Repertoire', color: 'w', projectKind: 'standard' },
  { name: 'Black Main Repertoire', color: 'b', projectKind: 'standard' },
];

export async function ensureDefaultMainRepertoires(): Promise<Repertoire[]> {
  const existing = await listRepertoires();
  if (existing.length > 0) return existing;

  const created: Repertoire[] = [];
  for (const starter of DEFAULT_MAIN_REPERTOIRES) {
    created.push(await createRepertoire(starter));
  }
  return created;
}

export async function createRepertoire(options: CreateRepertoireOptions): Promise<Repertoire> {
  const db = await getDB();
  const now = new Date().toISOString();
  const rep: Repertoire = {
    id: newId('rep'),
    name: options.name.trim() || 'Untitled repertoire',
    color: options.color,
    rootFen: options.rootFen ?? STARTING_FEN_NORM,
    openingKey: options.openingKey ?? null,
    projectKind: options.projectKind ?? 'standard',
    createdAt: now,
    updatedAt: now,
  };
  await db.put('repertoires', rep);
  let cursorFen: NormFen = rep.rootFen;
  await ensureNode(cursorFen);
  for (const [idx, move] of (options.moves ?? []).entries()) {
    const result = await playMoveInRepertoire(rep.id, cursorFen, move, { isScaffold: idx < (options.scaffoldPlyCount ?? 0) });
    if (!result) throw new Error(`Could not add move ${move} from this position.`);
    cursorFen = result.edge.childFen;
  }
  return rep;
}

export async function createRepertoireFromOpening(opening: ResolvedOpeningLine): Promise<Repertoire> {
  return createRepertoire({
    name: opening.name,
    color: opening.color,
    openingKey: opening.key,
    rootFen: computeOpeningFen(opening.moves),
    // Root IS the opening position — no scaffold moves needed.
  });
}

// Convenience for callers that pass a key.
export async function createRepertoireByKey(openingKey: string): Promise<Repertoire> {
  const op = findOpening(openingKey);
  if (!op) throw new Error(`Unknown opening: ${openingKey}`);
  return createRepertoireFromOpening(op);
}

export interface AddLineResult {
  addedEdges: number;
  reusedEdges: number;
}

export async function addOpeningToRepertoire(repertoireId: string, openingKey: string): Promise<AddLineResult> {
  const opening = findOpening(openingKey);
  if (!opening) throw new Error(`Unknown opening: ${openingKey}`);
  const rep = await getRepertoire(repertoireId);
  if (!rep) throw new Error('Could not find that repertoire.');
  if (rep.color !== opening.color) {
    throw new Error(`${opening.name} is a ${opening.color === 'w' ? 'White' : 'Black'} opening. Add it to a ${opening.color === 'w' ? 'White' : 'Black'} repertoire.`);
  }
  const result = await addMovesToRepertoire(rep, opening.moves, { scaffoldPlyCount: opening.moves.length });
  await markCuratedOpeningScaffolds(rep);
  return result;
}

export interface AddMovesOptions {
  scaffoldPlyCount?: number;
}

export async function addMovesToRepertoire(rep: Repertoire, moves: string[], options: AddMovesOptions = {}): Promise<AddLineResult> {
  let cursorFen: NormFen = rep.rootFen;
  let addedEdges = 0;
  let reusedEdges = 0;
  for (const [idx, move] of moves.entries()) {
    const result = applyMove(cursorFen, move);
    if (!result) throw new Error(`Could not add move ${move} from this position.`);

    const isScaffold = idx < (options.scaffoldPlyCount ?? 0);
    const outgoing = await getEdgesFromParent(rep.id, cursorFen);
    const exact = outgoing.find(e => e.uci === result.uci);
    const conflictsWithYourChoice = result.mover === rep.color
      && !isScaffold
      && cursorFen !== rep.rootFen
      && outgoing.some(e => e.mover === rep.color && !e.isScaffold && e.uci !== result.uci);
    if (conflictsWithYourChoice) {
      const existing = outgoing.find(e => e.mover === rep.color && !e.isScaffold);
      throw new Error(`That opening conflicts at ${existing?.san ?? 'an existing move'}. Create a separate repertoire if you want to study both choices from the same position.`);
    }

    const played = await playMoveInRepertoire(rep.id, cursorFen, move, { isScaffold });
    if (!played) throw new Error(`Could not add move ${move} from this position.`);
    if (played.edgeCreated) addedEdges++;
    else if (exact) reusedEdges++;
    cursorFen = played.edge.childFen;
  }
  return { addedEdges, reusedEdges };
}

export async function markCuratedOpeningScaffolds(rep: Repertoire): Promise<number> {
  let updated = 0;
  for (const opening of CURATED_OPENINGS.filter(item => item.color === rep.color)) {
    let cursorFen: NormFen = rep.rootFen;
    for (const move of opening.moves) {
      const result = applyMove(cursorFen, move);
      if (!result) break;
      const edge = await getEdge(rep.id, cursorFen, result.fen);
      if (!edge) {
        cursorFen = result.fen;
        continue;
      }
      if (!edge.isScaffold) {
        await putEdge({ ...edge, isScaffold: true });
        updated++;
      }
      cursorFen = result.fen;
    }
  }
  return updated;
}

export async function createRepertoireFromFen(name: string, color: Color, fen: string, projectKind?: Repertoire['projectKind']): Promise<Repertoire> {
  const chess = new Chess(fen);
  return createRepertoire({ name, color, rootFen: normalizeFen(chess.fen()), projectKind });
}

export async function createRepertoireFromPgn(name: string, color: Color, pgn: string, maxPlies = 24, projectKind?: Repertoire['projectKind']): Promise<Repertoire> {
  const chess = new Chess();
  chess.loadPgn(pgn, { strict: false });
  const moves = chess.history().slice(0, maxPlies);
  return createRepertoire({ name, color, moves, projectKind });
}

export async function cloneRepertoire(sourceId: string, name?: string): Promise<Repertoire> {
  const source = await getRepertoire(sourceId);
  if (!source) throw new Error('Could not find the repertoire to clone.');
  const db = await getDB();
  const sourceEdges = await getEdgesForRepertoire(sourceId);
  const now = new Date().toISOString();
  const clone: Repertoire = {
    ...source,
    id: newId('rep'),
    name: name?.trim() || `${source.name} copy`,
    createdAt: now,
    updatedAt: now,
  };
  await db.put('repertoires', clone);
  for (const edge of sourceEdges) {
    await putEdge({
      ...edge,
      id: edgeId(clone.id, edge.parentFen, edge.childFen),
      repertoireId: clone.id,
      createdAt: now,
    });
  }
  return clone;
}

// ---------- Nodes ----------

export async function ensureNode(fen: NormFen): Promise<PositionNode> {
  const db = await getDB();
  const existing = await db.get('nodes', fen);
  if (existing) return existing;
  const node: PositionNode = { fen, createdAt: new Date().toISOString() };
  await db.put('nodes', node);
  return node;
}

export async function getAllNodes(): Promise<PositionNode[]> {
  const db = await getDB();
  return db.getAll('nodes');
}

// ---------- Edges (per-repertoire) ----------

export async function getEdgesForRepertoire(repertoireId: string): Promise<Edge[]> {
  const db = await getDB();
  return db.getAllFromIndex('edges', 'by-repertoire', repertoireId);
}

export async function getEdge(repertoireId: string, parentFen: NormFen, childFen: NormFen): Promise<Edge | undefined> {
  const db = await getDB();
  return db.get('edges', edgeId(repertoireId, parentFen, childFen));
}

export async function getEdgesFromParent(repertoireId: string, parentFen: NormFen): Promise<Edge[]> {
  const db = await getDB();
  return db.getAllFromIndex('edges', 'by-rep-parent', [repertoireId, parentFen]);
}

export async function getEdgesIntoChild(repertoireId: string, childFen: NormFen): Promise<Edge[]> {
  const db = await getDB();
  return db.getAllFromIndex('edges', 'by-rep-child', [repertoireId, childFen]);
}

export async function getEdgesByMover(repertoireId: string, mover: Color): Promise<Edge[]> {
  const db = await getDB();
  const edges = await db.getAllFromIndex('edges', 'by-rep-mover', [repertoireId, mover]);
  return edges.filter(edge => !edge.isScaffold);
}

export async function putEdge(edge: Edge): Promise<void> {
  const db = await getDB();
  await db.put('edges', edge);
}

// ---------- Frontier Queue ----------

function sortFrontiers(frontiers: FrontierCandidate[]): FrontierCandidate[] {
  return [...frontiers].sort((a, b) => (
    (b.weight - a.weight)
    || (b.games - a.games)
    || b.updatedAt.localeCompare(a.updatedAt)
  ));
}

export async function getFrontiersForRepertoire(repertoireId: string): Promise<FrontierCandidate[]> {
  const db = await getDB();
  const frontiers = await db.getAllFromIndex('frontiers', 'by-repertoire', repertoireId);
  return sortFrontiers(frontiers);
}

export async function getOpenFrontiers(repertoireId: string): Promise<FrontierCandidate[]> {
  const db = await getDB();
  const frontiers = await db.getAllFromIndex('frontiers', 'by-rep-status', [repertoireId, 'open']);
  return sortFrontiers(frontiers);
}

export async function putFrontiers(frontiers: FrontierCandidate[]): Promise<void> {
  if (frontiers.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('frontiers', 'readwrite');
  for (const frontier of frontiers) {
    const existing = await tx.store.get(frontier.id);
    await tx.store.put({
      ...frontier,
      createdAt: existing?.createdAt ?? frontier.createdAt,
      status: existing?.status === 'blocked' ? existing.status : frontier.status,
      lastReason: existing?.status === 'blocked' ? existing.lastReason : frontier.lastReason,
    });
  }
  await tx.done;
}

export async function markFrontierAnswered(frontierId: string, reason = 'A user move was added for this frontier.'): Promise<void> {
  const db = await getDB();
  const frontier = await db.get('frontiers', frontierId);
  if (!frontier || frontier.status === 'answered') return;
  await db.put('frontiers', {
    ...frontier,
    status: 'answered',
    lastReason: reason,
    updatedAt: new Date().toISOString(),
  });
}

export async function markFrontiersAnsweredByChildFen(repertoireId: string, childFen: NormFen, reason = 'A user move was added for this frontier.'): Promise<number> {
  const db = await getDB();
  const matches = await db.getAllFromIndex('frontiers', 'by-rep-child', [repertoireId, childFen]);
  if (matches.length === 0) return 0;
  const tx = db.transaction('frontiers', 'readwrite');
  const now = new Date().toISOString();
  let updated = 0;
  for (const frontier of matches) {
    if (frontier.status === 'answered') continue;
    await tx.store.put({ ...frontier, status: 'answered', lastReason: reason, updatedAt: now });
    updated++;
  }
  await tx.done;
  return updated;
}

export async function markFrontierBlocked(frontierId: string, reason: string): Promise<void> {
  const db = await getDB();
  const frontier = await db.get('frontiers', frontierId);
  if (!frontier) return;
  await db.put('frontiers', {
    ...frontier,
    status: 'blocked',
    lastReason: reason,
    updatedAt: new Date().toISOString(),
  });
}

export async function clearFrontiersForRepertoire(repertoireId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('frontiers', 'readwrite');
  const idx = tx.store.index('by-repertoire');
  let cur = await idx.openCursor(IDBKeyRange.only(repertoireId));
  while (cur) {
    await cur.delete();
    cur = await cur.continue();
  }
  await tx.done;
}

export interface PlayMoveResult {
  edge: Edge;
  childCreated: boolean;
  edgeCreated: boolean;
}

export async function playMoveInRepertoire(
  repertoireId: string,
  fromFen: NormFen,
  move: string | { from: string; to: string; promotion?: string },
  options: { isScaffold?: boolean } = {}
): Promise<PlayMoveResult | null> {
  const result = applyMove(fromFen, move);
  if (!result) return null;
  const { fen: childFen, san, uci, mover } = result;
  const db = await getDB();
  const tx = db.transaction(['nodes', 'edges'], 'readwrite');
  const nodes = tx.objectStore('nodes');
  const edges = tx.objectStore('edges');

  const now = new Date().toISOString();
  if (!(await nodes.get(fromFen))) await nodes.put({ fen: fromFen, createdAt: now });
  let childCreated = false;
  if (!(await nodes.get(childFen))) {
    await nodes.put({ fen: childFen, createdAt: now });
    childCreated = true;
  }

  const eid = edgeId(repertoireId, fromFen, childFen);
  let edge = await edges.get(eid);
  let edgeCreated = false;
  if (!edge) {
    edge = {
      id: eid,
      repertoireId,
      parentFen: fromFen,
      childFen,
      san,
      uci,
      mover,
      ...(options.isScaffold ? { isScaffold: true } : {}),
      ...freshSrsState(),
      createdAt: now,
    };
    edgeCreated = true;
    await edges.put(edge);
  } else if (edge.isScaffold && !options.isScaffold) {
    edge = { ...edge, isScaffold: false };
    await edges.put(edge);
  }
  await tx.done;
  return { edge, childCreated, edgeCreated };
}

// Delete a position-rooted subtree within ONE repertoire.
// Other repertoires' edges through the same FENs are untouched.
export async function deleteSubtreeInRepertoire(repertoireId: string, fen: NormFen): Promise<{ edgesDeleted: number }> {
  const db = await getDB();
  const repEdges = await db.getAllFromIndex('edges', 'by-repertoire', repertoireId);
  // BFS forward from fen using only edges in this repertoire.
  const byParent = new Map<NormFen, Edge[]>();
  for (const e of repEdges) {
    let arr = byParent.get(e.parentFen);
    if (!arr) { arr = []; byParent.set(e.parentFen, arr); }
    arr.push(e);
  }
  const reach = new Set<NormFen>([fen]);
  const queue: NormFen[] = [fen];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of byParent.get(cur) || []) {
      if (!reach.has(e.childFen)) {
        reach.add(e.childFen);
        queue.push(e.childFen);
      }
    }
  }
  // A descendant is safe to "remove from this repertoire" if all its parent edges (in this rep)
  // come from positions in `reach`. Otherwise leave its inbound edges from outside alone.
  // Simpler: just delete every edge whose parent is in `reach` AND who lies inside this rep.
  // (Edges TO `fen` from outside `reach` are kept — they survive as broken pointers, which is
  // visually fine because the child would no longer be reachable via the deleted subtree.)
  // Actually, we want to also delete the edge that points INTO `fen` if `fen` was the user's
  // explicit deletion target — that edge's "your move" would otherwise still appear as a card
  // for a now-empty branch. But in this app, the user doesn't delete the edge-INTO-fen, they
  // delete fen and what's below. We'll prune edges whose parent is in reach OR whose child === fen.
  const tx = db.transaction(['edges'], 'readwrite');
  const edgeStore = tx.objectStore('edges');
  let edgesDeleted = 0;
  for (const e of repEdges) {
    if (reach.has(e.parentFen)) {
      await edgeStore.delete(e.id);
      edgesDeleted++;
    }
  }
  await tx.done;
  return { edgesDeleted };
}

// Replace an existing your-move at parentFen with a different attempted move.
// Deletes the old outgoing edge AND the subtree below it (in this rep), then creates the new edge with fresh SRS.
// Used by the "you got it wrong twice — switch?" override flow.
export async function swapMoveInRepertoire(
  repertoireId: string,
  parentFen: NormFen,
  oldChildFen: NormFen,
  attemptedMove: string | { from: string; to: string; promotion?: string }
): Promise<PlayMoveResult | null> {
  // Subtree-delete starting at oldChildFen: removes oldChildFen's outgoing edges and below.
  await deleteSubtreeInRepertoire(repertoireId, oldChildFen);
  // Then explicitly delete the parentFen → oldChildFen edge (deleteSubtree only deletes edges
  // whose parent is in the reach set, which doesn't include parentFen).
  const db = await getDB();
  await db.delete('edges', edgeId(repertoireId, parentFen, oldChildFen));
  // Add the new move.
  return playMoveInRepertoire(repertoireId, parentFen, attemptedMove);
}

export async function resetAllSrsForRepertoire(repertoireId: string): Promise<number> {
  const db = await getDB();
  const all = await db.getAllFromIndex('edges', 'by-repertoire', repertoireId);
  const tx = db.transaction('edges', 'readwrite');
  const store = tx.objectStore('edges');
  let n = 0;
  for (const e of all) {
    if (e.isScaffold) continue;
    await store.put({ ...e, ...freshSrsState() });
    n++;
  }
  await tx.done;
  return n;
}

// ---------- Contamination cleanup ----------

// Removes non-scaffold opponent edges that were incorrectly added to curated opening
// repertoires by old versions of the line generation algorithm. For example, 1...c5
// (Sicilian) or 1...e6 (French) stored under an Italian Game repertoire.
// Safe to call repeatedly — a no-op if no contamination exists.
export async function removeScaffoldContamination(repertoireId: string): Promise<number> {
  const db = await getDB();
  const allEdges: Edge[] = await db.getAllFromIndex('edges', 'by-repertoire', repertoireId);
  if (allEdges.length === 0) return 0;

  const byParent = new Map<string, Edge[]>();
  const byId = new Map<string, Edge>();
  for (const e of allEdges) {
    byId.set(e.id, e);
    const arr = byParent.get(e.parentFen) ?? [];
    arr.push(e);
    byParent.set(e.parentFen, arr);
  }

  const rep = await db.get('repertoires', repertoireId);
  if (!rep) return 0;

  // Walk scaffold edges to find *intermediate* scaffold positions — those that have at
  // least one outgoing scaffold edge (i.e. the scaffold path continues from here).
  // The scaffold *endpoint* (the last scaffold position, e.g. after 3.Bc4 in Italian)
  // is excluded because that is where legitimate non-scaffold branches begin.
  const intermediateScaffoldPositions = new Set<string>();
  const stack = [rep.rootFen];
  const visited = new Set<string>();
  while (stack.length) {
    const fen = stack.pop()!;
    if (visited.has(fen)) continue;
    visited.add(fen);
    const outgoing = byParent.get(fen) ?? [];
    const scaffoldOut = outgoing.filter(e => e.isScaffold);
    if (scaffoldOut.length > 0) {
      // This position has outgoing scaffold moves, so it is intermediate.
      intermediateScaffoldPositions.add(fen);
      for (const e of scaffoldOut) stack.push(e.childFen);
    }
  }

  // Contamination: non-scaffold opponent edges at intermediate scaffold positions.
  // These are off-repertoire lines (Sicilian, Caro-Kann, Petrov, etc.) that were
  // incorrectly generated alongside the intended scaffold path.
  const toDelete = new Set<string>();
  for (const fen of intermediateScaffoldPositions) {
    for (const e of (byParent.get(fen) ?? [])) {
      if (e.mover !== rep.color && !e.isScaffold) toDelete.add(e.id);
    }
  }
  if (toDelete.size === 0) return 0;

  // BFS to collect all descendants of contaminated edges.
  const bfsQueue = [...toDelete];
  while (bfsQueue.length) {
    const id = bfsQueue.shift()!;
    const edge = byId.get(id);
    if (!edge) continue;
    for (const child of (byParent.get(edge.childFen) ?? [])) {
      if (!toDelete.has(child.id)) {
        toDelete.add(child.id);
        bfsQueue.push(child.id);
      }
    }
  }

  const tx = db.transaction('edges', 'readwrite');
  for (const id of toDelete) tx.store.delete(id);
  await tx.done;
  return toDelete.size;
}

// One-time migration: for every curated-opening repertoire whose rootFen is still the
// starting position, advance rootFen to the position after the opening moves and delete
// the scaffold path + any contamination that lived before that position.
export async function migrateToFenRoots(): Promise<void> {
  const reps = await listRepertoires();
  for (const rep of reps) {
    if (!rep.openingKey) continue;
    if (rep.rootFen !== STARTING_FEN_NORM) continue; // already migrated
    const opening = findOpening(rep.openingKey);
    if (!opening || opening.moves.length === 0) continue;

    const newRootFen = computeOpeningFen(opening.moves);
    if (newRootFen === STARTING_FEN_NORM) continue;

    const db = await getDB();
    const allEdges: Edge[] = await db.getAllFromIndex('edges', 'by-repertoire', rep.id);

    const byParent = new Map<string, Edge[]>();
    for (const e of allEdges) {
      const arr = byParent.get(e.parentFen) ?? [];
      arr.push(e);
      byParent.set(e.parentFen, arr);
    }

    // BFS from newRootFen to find all reachable edge IDs.
    const reachable = new Set<string>();
    const queue = [newRootFen];
    const visitedFens = new Set<string>();
    while (queue.length) {
      const fen = queue.shift()!;
      if (visitedFens.has(fen)) continue;
      visitedFens.add(fen);
      for (const e of (byParent.get(fen) ?? [])) {
        reachable.add(e.id);
        queue.push(e.childFen);
      }
    }

    // Delete scaffold path + contamination; advance rootFen.
    const toDelete = allEdges.filter(e => !reachable.has(e.id)).map(e => e.id);
    const tx = db.transaction(['repertoires', 'edges'], 'readwrite');
    for (const id of toDelete) tx.objectStore('edges').delete(id);
    tx.objectStore('repertoires').put({ ...rep, rootFen: newRootFen, updatedAt: new Date().toISOString() });
    await tx.done;
  }
}

// ---------- Meta ----------

export async function setMeta<T = unknown>(key: string, value: T): Promise<void> {
  const db = await getDB();
  await db.put('meta', { key, value });
}

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  const db = await getDB();
  const rec = await db.get('meta', key);
  return rec?.value as T | undefined;
}

// ---------- Export / Import ----------

export interface ExportData {
  version: 2 | 3;
  exportedAt: string;
  repertoires: Repertoire[];
  nodes: PositionNode[];
  edges: Edge[];
  frontiers?: FrontierCandidate[];
}

export async function exportAll(): Promise<ExportData> {
  const [repertoires, nodes, edges, frontiers] = await Promise.all([listRepertoires(), getAllNodes(), (async () => {
    const db = await getDB();
    return db.getAll('edges');
  })(), (async () => {
    const db = await getDB();
    return db.getAll('frontiers');
  })()]);
  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    repertoires,
    nodes,
    edges,
    frontiers,
  };
}

export async function importAll(data: ExportData, mode: 'replace' | 'merge' = 'replace'): Promise<void> {
  if (data.version !== 2 && data.version !== 3) throw new Error(`Unsupported export version: ${data.version}`);
  const db = await getDB();
  const tx = db.transaction(['repertoires', 'nodes', 'edges', 'frontiers'], 'readwrite');
  if (mode === 'replace') {
    await tx.objectStore('repertoires').clear();
    await tx.objectStore('nodes').clear();
    await tx.objectStore('edges').clear();
    await tx.objectStore('frontiers').clear();
  }
  for (const r of data.repertoires) await tx.objectStore('repertoires').put(r);
  for (const n of data.nodes) await tx.objectStore('nodes').put(n);
  for (const e of data.edges) await tx.objectStore('edges').put(e);
  for (const f of data.frontiers ?? []) await tx.objectStore('frontiers').put(f);
  await tx.done;
}

// Re-export curated openings for convenience.
export { CURATED_OPENINGS };
