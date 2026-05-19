import { describe, expect, it } from 'vitest';
import type { Edge, NormFen } from '../types';
import { applyMove, STARTING_FEN_NORM } from './chess';
import { buildReviewPlan, pathFromRootToEdge, buildPathIndex } from './reviewPlan';

const REP_ID = 'rep-review-plan';
const NOW = new Date().toISOString();

function makeEdge(fields: Partial<Edge> & Pick<Edge, 'parentFen' | 'childFen' | 'san' | 'uci' | 'mover'>): Edge {
  return {
    id: `${REP_ID}::${fields.parentFen}::${fields.childFen}`,
    repertoireId: REP_ID,
    ease: 2.5,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    dueAt: NOW,
    lastReviewedAt: null,
    createdAt: NOW,
    ...fields,
  };
}

function play(edges: Edge[], fen: NormFen, move: string): { edge: Edge; fen: NormFen } {
  const applied = applyMove(fen, move);
  if (!applied) throw new Error(`Cannot play ${move} from ${fen}`);
  const edge = makeEdge({
    parentFen: fen,
    childFen: applied.fen,
    san: applied.san,
    uci: applied.uci,
    mover: applied.mover,
  });
  edges.push(edge);
  return { edge, fen: applied.fen };
}

describe('buildReviewPlan', () => {
  it('returns an empty plan for empty due cards', () => {
    const plan = buildReviewPlan([], [], STARTING_FEN_NORM);
    expect(plan.segments).toHaveLength(0);
    expect(plan.totalPrompts).toBe(0);
  });

  it('puts a single deep due card on a linear line into one segment with one prompt', () => {
    const edges: Edge[] = [];
    let fen = STARTING_FEN_NORM;
    ({ fen } = play(edges, fen, 'e4'));
    ({ fen } = play(edges, fen, 'e5'));
    ({ fen } = play(edges, fen, 'Nf3'));
    ({ fen } = play(edges, fen, 'Nc6'));
    ({ fen } = play(edges, fen, 'Bc4'));
    const due = play(edges, fen, 'Bc5');

    const plan = buildReviewPlan([due.edge], edges, STARTING_FEN_NORM);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].path).toHaveLength(6);
    expect(plan.segments[0].prompts).toHaveLength(1);
    expect(plan.segments[0].prompts[0].cardEdgeId).toBe(due.edge.id);
    expect(plan.segments[0].prompts[0].pathIdx).toBe(5);
    expect(plan.totalPrompts).toBe(1);
    expect(plan.totalContextPlies).toBe(5);
  });

  it('merges two collinear due cards (same line, different depths) into one segment with two prompts', () => {
    const edges: Edge[] = [];
    let fen = STARTING_FEN_NORM;
    ({ fen } = play(edges, fen, 'e4'));
    ({ fen } = play(edges, fen, 'e5'));
    ({ fen } = play(edges, fen, 'Nf3'));
    ({ fen } = play(edges, fen, 'Nc6'));
    const dueShallow = play(edges, fen, 'Bc4');
    fen = dueShallow.fen;
    ({ fen } = play(edges, fen, 'Bc5'));
    ({ fen } = play(edges, fen, 'b4'));
    ({ fen } = play(edges, fen, 'Bxb4'));
    const dueDeep = play(edges, fen, 'c3');

    // Pass shallow first, deep second — order shouldn't matter for merge.
    const plan = buildReviewPlan([dueShallow.edge, dueDeep.edge], edges, STARTING_FEN_NORM);
    expect(plan.segments).toHaveLength(1);
    const seg = plan.segments[0];
    expect(seg.path).toHaveLength(9);
    expect(seg.prompts).toHaveLength(2);
    expect(seg.prompts[0].pathIdx).toBeLessThan(seg.prompts[1].pathIdx);
    expect(seg.prompts.map(p => p.cardEdgeId).sort()).toEqual([dueShallow.edge.id, dueDeep.edge.id].sort());
  });

  it('merges still works when the deeper card is listed first (segment path gets extended)', () => {
    const edges: Edge[] = [];
    let fen = STARTING_FEN_NORM;
    ({ fen } = play(edges, fen, 'e4'));
    ({ fen } = play(edges, fen, 'e5'));
    const dueShallow = play(edges, fen, 'Nf3');
    fen = dueShallow.fen;
    ({ fen } = play(edges, fen, 'Nc6'));
    const dueDeep = play(edges, fen, 'Bc4');

    // Order: deep card first, then shallow.
    const plan = buildReviewPlan([dueDeep.edge, dueShallow.edge], edges, STARTING_FEN_NORM);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].path).toHaveLength(5);
    expect(plan.segments[0].prompts).toHaveLength(2);
  });

  it('opens a separate segment for due cards on diverging branches', () => {
    const edges: Edge[] = [];
    let fen = STARTING_FEN_NORM;
    ({ fen } = play(edges, fen, 'e4'));
    ({ fen } = play(edges, fen, 'e5'));
    ({ fen } = play(edges, fen, 'Nf3'));
    ({ fen } = play(edges, fen, 'Nc6'));
    const afterNc6 = fen;
    // Branch A: Italian (Bc4)
    const dueA = play(edges, fen, 'Bc4');
    // Branch B: Scotch (d4) — separate branch from same parent
    fen = afterNc6;
    const dueB = play(edges, fen, 'd4');

    const plan = buildReviewPlan([dueA.edge, dueB.edge], edges, STARTING_FEN_NORM);
    expect(plan.segments).toHaveLength(2);
    expect(plan.totalPrompts).toBe(2);
    // First segment opens for the first-listed card (dueA).
    expect(plan.segments[0].prompts[0].cardEdgeId).toBe(dueA.edge.id);
    expect(plan.segments[1].prompts[0].cardEdgeId).toBe(dueB.edge.id);
  });

  it('drops a card whose path cannot be traced from the scope root', () => {
    const edges: Edge[] = [];
    // Orphan: an edge whose parent FEN is unreachable from STARTING_FEN_NORM.
    const orphan = makeEdge({
      parentFen: 'orphan/parent/fen w - - 0 1' as NormFen,
      childFen: 'orphan/child/fen w - - 0 1' as NormFen,
      san: 'X', uci: 'a1a1', mover: 'w',
    });
    edges.push(orphan);

    const plan = buildReviewPlan([orphan], edges, STARTING_FEN_NORM);
    expect(plan.segments).toHaveLength(0);
    expect(plan.droppedCards).toContain(orphan.id);
  });

  it('does not infinite-loop on cyclic edge data (parentFen === childFen self-loop)', () => {
    const cyclic = makeEdge({
      parentFen: STARTING_FEN_NORM,
      childFen: STARTING_FEN_NORM,  // self-loop
      san: 'X', uci: 'a1a1', mover: 'w',
    });
    // pathFromRootToEdge should return null without hanging.
    const byParent = buildPathIndex([cyclic]);
    const t0 = Date.now();
    const result = pathFromRootToEdge(STARTING_FEN_NORM, cyclic, byParent);
    expect(Date.now() - t0).toBeLessThan(100);
    // Self-loop means we cannot use rootFen===childFen as a "found" condition;
    // path is dropped.
    expect(result).toBeNull();
  });

  it('preserves segment emit order matching the order each segment opens', () => {
    const edges: Edge[] = [];
    let fen = STARTING_FEN_NORM;
    ({ fen } = play(edges, fen, 'e4'));
    ({ fen } = play(edges, fen, 'e5'));
    const dueItalianAt3 = play(edges, fen, 'Nf3');
    // Branch B starting from a different first move so it's clearly separate.
    fen = STARTING_FEN_NORM;
    const dueQueensPawnAt1 = play(edges, fen, 'd4');

    // Pass d4 *first* — it should open the first segment.
    const plan = buildReviewPlan([dueQueensPawnAt1.edge, dueItalianAt3.edge], edges, STARTING_FEN_NORM);
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0].prompts[0].cardEdgeId).toBe(dueQueensPawnAt1.edge.id);
    expect(plan.segments[1].prompts[0].cardEdgeId).toBe(dueItalianAt3.edge.id);
  });
});

describe('pathFromRootToEdge', () => {
  it('returns null when target is unreachable', () => {
    const edges: Edge[] = [];
    let fen = STARTING_FEN_NORM;
    ({ fen } = play(edges, fen, 'e4'));
    const isolated = makeEdge({
      parentFen: 'isolated/parent w - - 0 1' as NormFen,
      childFen: 'isolated/child w - - 0 1' as NormFen,
      san: 'X', uci: 'a1a1', mover: 'w',
    });
    const byParent = buildPathIndex([...edges, isolated]);
    const result = pathFromRootToEdge(STARTING_FEN_NORM, isolated, byParent);
    expect(result).toBeNull();
  });

  it('returns the correct edge sequence for a reachable target', () => {
    const edges: Edge[] = [];
    let fen = STARTING_FEN_NORM;
    ({ fen } = play(edges, fen, 'e4'));
    ({ fen } = play(edges, fen, 'e5'));
    const target = play(edges, fen, 'Nf3');
    const byParent = buildPathIndex(edges);
    const result = pathFromRootToEdge(STARTING_FEN_NORM, target.edge, byParent);
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(3);
    expect(result![2].id).toBe(target.edge.id);
  });
});
