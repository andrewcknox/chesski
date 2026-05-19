import type { Edge, NormFen, Repertoire } from '../types';
import type { OpeningFolder } from './openingFolders';
import { isDue } from './srs';

export function isTrainableEdge(edge: Edge, color: Repertoire['color']): boolean {
  return edge.mover === color && !edge.isScaffold;
}

/**
 * Returns edges scoped to an opening folder.
 *
 * @param folder           The opening folder (defines the path and baseFen).
 * @param edges            The candidate edges to include in the result.
 *                         Only edges whose IDs appear in this array will be returned.
 * @param navigationEdges  Full edge set used for BFS graph traversal.
 *                         Must include opponent-color edges so the BFS can step through
 *                         Black responses and reach White reply positions.
 *                         Defaults to `edges` when omitted (backward-compatible).
 *
 * The bug this fixes: when `edges` is pre-filtered to non-scaffold user-color moves
 * (as in the review queue), the BFS from baseFen immediately stalls because the first
 * outgoing edges are opponent moves that aren't in the filtered set.  Passing the full
 * repository edge list as `navigationEdges` lets the BFS traverse through opponent moves
 * while the result is still restricted to the edges in `edges`.
 *
 * Path-edge inclusion is also guarded: folder.path scaffold edges are only added to the
 * result if they are present in `edges`, preventing scaffold moves from leaking into the
 * review queue.
 */
export function edgesForOpeningFolder(
  folder: OpeningFolder,
  edges: Edge[],
  navigationEdges?: Edge[],
): Edge[] {
  const nav = navigationEdges ?? edges;
  const folderEdgeIds = new Set(folder.path.map(e => e.id));
  const edgeIds = new Set(edges.map(e => e.id));

  const byParent = new Map<NormFen, Edge[]>();
  for (const edge of nav) {
    const list = byParent.get(edge.parentFen) ?? [];
    list.push(edge);
    byParent.set(edge.parentFen, list);
  }

  const result: Edge[] = [];
  const seen = new Set<string>();

  // Include path (scaffold stem) edges only if they belong to the target edge set.
  // Always mark them seen so the BFS below won't re-add them.
  for (const edge of folder.path) {
    seen.add(edge.id);
    if (edgeIds.has(edge.id)) result.push(edge);
  }

  // BFS from the opening tabiya, collecting edges that belong to the result set.
  // We traverse nav (full graph) so the BFS can step through opponent moves to reach
  // the user-color reply positions that actually need to be reviewed.
  const stack = [folder.baseFen];
  const visited = new Set<NormFen>();
  while (stack.length) {
    const fen = stack.pop()!;
    if (visited.has(fen)) continue;
    visited.add(fen);
    for (const edge of byParent.get(fen) ?? []) {
      if (!seen.has(edge.id)) {
        seen.add(edge.id);
        if (edgeIds.has(edge.id)) result.push(edge);
      }
      // Follow every non-path edge so we traverse the full tree reachable from baseFen.
      if (!folderEdgeIds.has(edge.id)) stack.push(edge.childFen);
    }
  }
  return result;
}

export function buildReviewQueue(
  edges: Edge[],
  includeFallback: boolean,
  cap: number,
  forceFallback = false,
): Edge[] {
  const now = new Date();
  const due = edges
    .filter(e => isDue(e, now))
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  if (!includeFallback) return due.slice(0, cap);
  if (due.length > 0 && !forceFallback) return due.slice(0, cap);
  const dueIds = new Set(due.map(e => e.id));
  const fallback = edges
    .filter(e => !dueIds.has(e.id))
    .sort((a, b) => {
      const aReviewed = a.lastReviewedAt ? new Date(a.lastReviewedAt).getTime() : 0;
      const bReviewed = b.lastReviewedAt ? new Date(b.lastReviewedAt).getTime() : 0;
      if (aReviewed !== bReviewed) return aReviewed - bReviewed;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  return [...due, ...fallback].slice(0, cap);
}
