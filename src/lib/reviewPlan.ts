import type { Edge, NormFen } from '../types';

// Line-aware review delivery — see docs/wishlist.md ("Chessable-style SRS
// review rework"). This module reshapes the flat dueAt-sorted queue from
// buildReviewQueue() into a sequence of "segments" — linear walks from the
// scope root through the repertoire tree, with prompt points marked at each
// due card. SRS state stays per-edge; only the *presentation order* changes.
//
// Critical: this is a delivery-layer transform. It must not mutate edges,
// trigger grade calls, or alter dueAt logic. The flat queue's dueAt-asc order
// is preserved at the segment level (first card in dueAt order opens the
// first segment; collinear cards merge into existing open segments).

export interface ReviewPrompt {
  cardEdgeId: string;     // Edge id of the due card being prompted.
  pathIdx: number;        // 0-based ply within segment.path where the prompt fires.
}

export interface ReviewSegment {
  segmentId: string;
  rootFen: NormFen;       // Scope root — the FEN the board shows before path[0] plays.
  path: Edge[];           // Linear sequence of edges, root → segment end.
  prompts: ReviewPrompt[]; // Prompt points along path, sorted by pathIdx asc.
}

export interface ReviewPlan {
  segments: ReviewSegment[];
  totalPrompts: number;
  totalContextPlies: number;  // Sum over segments of (path.length - prompts.length).
  droppedCards: string[];     // Edge ids that could not be planned (reasons in trace).
  trace: string[];            // Debug trace for the failure-report path.
}

// Build a parentFen -> children index from a scoped edge set. Stable iteration
// order over the input is preserved per parent (FIFO).
export function buildPathIndex(scopedEdges: Edge[]): Map<NormFen, Edge[]> {
  const map = new Map<NormFen, Edge[]>();
  for (const edge of scopedEdges) {
    const arr = map.get(edge.parentFen);
    if (arr) arr.push(edge);
    else map.set(edge.parentFen, [edge]);
  }
  return map;
}

// BFS from rootFen across the parent->children index. Returns the shortest
// sequence of edges from rootFen down to and including `target`, or null if
// `target` is unreachable from rootFen via stored edges. Cycle-safe via a
// visited-FEN set (synthetic test data with parentFen === childFen will not
// loop).
export function pathFromRootToEdge(
  rootFen: NormFen,
  target: Edge,
  byParent: Map<NormFen, Edge[]>,
): Edge[] | null {
  if (rootFen === target.childFen) return null; // Edge cannot be "self".
  type Node = { fen: NormFen; path: Edge[] };
  const queue: Node[] = [{ fen: rootFen, path: [] }];
  const visited = new Set<NormFen>([rootFen]);
  while (queue.length) {
    const { fen, path } = queue.shift()!;
    const children = byParent.get(fen);
    if (!children) continue;
    for (const child of children) {
      if (child.id === target.id) return [...path, child];
      if (child.childFen === child.parentFen) continue; // Self-loop guard.
      if (visited.has(child.childFen)) continue;
      visited.add(child.childFen);
      queue.push({ fen: child.childFen, path: [...path, child] });
    }
  }
  return null;
}

// True iff `a` is an element-wise prefix of `b` (compared by edge id).
function pathIsPrefixOf(a: Edge[], b: Edge[]): boolean {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}

// Top-level planner. Takes the already-sorted (dueAt-asc) flat review queue,
// the scoped edge set used to compute paths, and the scope's root FEN. Returns
// a plan with segments emitted in the order each segment's *first* card
// appeared in the input.
//
// Cards whose path cannot be computed from the scope root (orphaned by DB
// inconsistency, missing scaffold edge, etc.) are dropped into
// `plan.droppedCards` with a reason logged into `plan.trace`. The planner
// never throws on bad data — it produces the largest plan it can and reports
// the rest so the failure-report UI has something to copy.
export function buildReviewPlan(
  dueCardsInDueOrder: Edge[],
  scopedEdges: Edge[],
  scopeRootFen: NormFen,
): ReviewPlan {
  const trace: string[] = [];
  const droppedCards: string[] = [];
  trace.push(`Planner: dueCards=${dueCardsInDueOrder.length}, scopedEdges=${scopedEdges.length}, scopeRootFen=${scopeRootFen}`);

  const byParent = buildPathIndex(scopedEdges);
  const segments: ReviewSegment[] = [];

  for (const card of dueCardsInDueOrder) {
    if (scopeRootFen === card.parentFen) {
      // The card is at the very root — its "path" is just itself.
      attachOrOpen(segments, card, [card], trace);
      continue;
    }
    const path = pathFromRootToEdge(scopeRootFen, card, byParent);
    if (!path || path.length === 0) {
      droppedCards.push(card.id);
      trace.push(`Drop ${card.id} (${card.san}): no path from rootFen=${scopeRootFen} to childFen=${card.childFen}`);
      continue;
    }
    attachOrOpen(segments, card, path, trace);
  }

  const totalPrompts = segments.reduce((acc, seg) => acc + seg.prompts.length, 0);
  const totalContextPlies = segments.reduce((acc, seg) => acc + Math.max(0, seg.path.length - seg.prompts.length), 0);
  trace.push(`Planner: segments=${segments.length}, totalPrompts=${totalPrompts}, totalContextPlies=${totalContextPlies}, dropped=${droppedCards.length}`);

  return { segments, totalPrompts, totalContextPlies, droppedCards, trace };
}

// Attach a card to an existing collinear segment (if one exists) or open a
// new segment. Mutates `segments` in place; `trace` records the decision.
function attachOrOpen(
  segments: ReviewSegment[],
  card: Edge,
  path: Edge[],
  trace: string[],
): void {
  const lastPathEdgeId = path[path.length - 1].id;
  // Defensive: never prompt on a card that isn't actually the last edge of
  // its path (would mean the card sits mid-path, which shouldn't happen for
  // an SRS card).
  if (lastPathEdgeId !== card.id) {
    trace.push(`Skip ${card.id} (${card.san}): card edge is not the last step of its path; mid-path prompts are not supported`);
    return;
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (pathIsPrefixOf(seg.path, path) || pathIsPrefixOf(path, seg.path)) {
      // Collinear with this segment. Extend the segment path if the new card
      // goes deeper, then add the prompt.
      if (path.length > seg.path.length) {
        seg.path = path;
      }
      const pathIdx = locateEdgeIdxInPath(seg.path, card.id);
      if (pathIdx < 0) {
        trace.push(`Skip ${card.id} (${card.san}): could not locate prompt within merged segment path`);
        return;
      }
      // Avoid duplicate prompts (paranoia — the flat queue should not have duplicates).
      if (!seg.prompts.some(p => p.cardEdgeId === card.id)) {
        seg.prompts.push({ cardEdgeId: card.id, pathIdx });
        seg.prompts.sort((a, b) => a.pathIdx - b.pathIdx);
      }
      trace.push(`Merge ${card.id} (${card.san}) into segment ${seg.segmentId} at pathIdx=${pathIdx}`);
      return;
    }
  }
  // No collinear segment — open a new one.
  const segmentId = `seg-${segments.length}`;
  segments.push({
    segmentId,
    rootFen: path[0].parentFen,
    path,
    prompts: [{ cardEdgeId: card.id, pathIdx: path.length - 1 }],
  });
  trace.push(`Open ${segmentId} for ${card.id} (${card.san}) at depth=${path.length}`);
}

function locateEdgeIdxInPath(path: Edge[], edgeId: string): number {
  for (let i = 0; i < path.length; i++) {
    if (path[i].id === edgeId) return i;
  }
  return -1;
}
