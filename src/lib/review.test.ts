import { describe, it, expect } from 'vitest';
import type { Edge } from '../types';
import type { OpeningFolder } from './openingFolders';
import { applyMove, STARTING_FEN_NORM } from './chess';
import { buildReviewQueue, edgesForOpeningFolder, isTrainableEdge } from './review';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REP_ID = 'rep-italian-test';
const NOW_ISO = new Date().toISOString();

function makeEdge(fields: Partial<Edge> & Pick<Edge, 'id' | 'repertoireId' | 'parentFen' | 'childFen' | 'san' | 'uci' | 'mover'>): Edge {
  return {
    ease: 2.5,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    dueAt: NOW_ISO,
    lastReviewedAt: null,
    createdAt: NOW_ISO,
    ...fields,
  };
}

/** Build the Italian scaffold path (1.e4 e5 2.Nf3 Nc6 3.Bc4) with isScaffold=true. */
function buildItalianScaffold(): { path: Edge[]; baseFen: string } {
  const moves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'];
  let fen = STARTING_FEN_NORM;
  const path: Edge[] = [];
  for (const move of moves) {
    const r = applyMove(fen, move);
    if (!r) throw new Error(`Cannot play ${move}`);
    path.push(makeEdge({
      id: `${REP_ID}::${fen}::${r.fen}`,
      repertoireId: REP_ID,
      parentFen: fen,
      childFen: r.fen,
      san: r.san,
      uci: r.uci,
      mover: r.mover,
      isScaffold: true,
    }));
    fen = r.fen;
  }
  return { path, baseFen: fen };
}

/** Build a non-scaffold edge for a move played from `fromFen`. */
function buildPrepEdge(fromFen: string, move: string): Edge {
  const r = applyMove(fromFen, move);
  if (!r) throw new Error(`Cannot play ${move} from ${fromFen}`);
  return makeEdge({
    id: `${REP_ID}::${fromFen}::${r.fen}`,
    repertoireId: REP_ID,
    parentFen: fromFen,
    childFen: r.fen,
    san: r.san,
    uci: r.uci,
    mover: r.mover,
  });
}

/** Italian folder built from a scaffold path. */
function makeItalianFolder(path: Edge[], baseFen: string): OpeningFolder {
  return { key: 'italian-w', name: 'Italian Game', color: 'w', baseFen, path };
}

// ---------------------------------------------------------------------------
// Tests: isTrainableEdge
// ---------------------------------------------------------------------------

describe('isTrainableEdge', () => {
  const { path } = buildItalianScaffold();
  const [e4, e5, nf3] = path;

  it('returns false for scaffold edges regardless of mover', () => {
    expect(isTrainableEdge(e4, 'w')).toBe(false);  // White scaffold
    expect(isTrainableEdge(e5, 'b')).toBe(false);  // Black scaffold
  });

  it('returns false when mover does not match repertoire color', () => {
    const blackOppEdge = { ...nf3, isScaffold: undefined, mover: 'b' as const };
    expect(isTrainableEdge(blackOppEdge, 'w')).toBe(false);
  });

  it('returns true only for non-scaffold edges whose mover matches', () => {
    const whitePrep = { ...e4, isScaffold: undefined };
    expect(isTrainableEdge(whitePrep, 'w')).toBe(true);
    expect(isTrainableEdge(whitePrep, 'b')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Italian as White — scaffold moves excluded from review queue
// ---------------------------------------------------------------------------

describe('Italian as White — scaffold moves excluded', () => {
  const { path, baseFen } = buildItalianScaffold();
  const folder = makeItalianFolder(path, baseFen);

  // After 3.Bc4 it is Black to move. Black's response (e.g. ...Nf6) plus
  // White's reply (Ng5) constitute the actual preparation lines.
  const blackNf6 = buildPrepEdge(baseFen, 'Nf6');            // mover='b'
  const whiteNg5 = buildPrepEdge(blackNf6.childFen, 'Ng5');  // mover='w'
  const blackBc5 = buildPrepEdge(baseFen, 'Bc5');            // mover='b'
  const whiteC3  = buildPrepEdge(blackBc5.childFen, 'c3');   // mover='w'

  // fresh = non-scaffold White edges only (as returned by getEdgesByMover)
  const fresh = [whiteNg5, whiteC3];

  // allRepEdges = everything in the database (scaffold + prep, White + Black)
  const allRepEdges = [...path, blackNf6, whiteNg5, blackBc5, whiteC3];

  it('does not include e4, Nf3 or Bc4 in the review result', () => {
    const result = edgesForOpeningFolder(folder, fresh, allRepEdges);
    const sans = result.map(e => e.san);
    expect(sans).not.toContain('e4');
    expect(sans).not.toContain('Nf3');
    expect(sans).not.toContain('Bc4');
  });

  it('does not include Black scaffold moves (e5, Nc6) in the review result', () => {
    const result = edgesForOpeningFolder(folder, fresh, allRepEdges);
    const sans = result.map(e => e.san);
    expect(sans).not.toContain('e5');
    expect(sans).not.toContain('Nc6');
  });

  it('includes the actual White prep moves (Ng5, c3)', () => {
    const result = edgesForOpeningFolder(folder, fresh, allRepEdges);
    const sans = result.map(e => e.san);
    expect(sans).toContain('Ng5');
    expect(sans).toContain('c3');
  });

  it('every edge in the review result has mover=w and isScaffold falsy', () => {
    const result = edgesForOpeningFolder(folder, fresh, allRepEdges);
    for (const e of result) {
      expect(e.mover).toBe('w');
      expect(e.isScaffold).toBeFalsy();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: review session does not loop on the opening stem
// ---------------------------------------------------------------------------

describe('review queue — no loop on opening stem', () => {
  const { path, baseFen } = buildItalianScaffold();
  const folder = makeItalianFolder(path, baseFen);

  const blackNf6 = buildPrepEdge(baseFen, 'Nf6');
  const whiteNg5 = buildPrepEdge(blackNf6.childFen, 'Ng5');
  const fresh = [whiteNg5];
  const allRepEdges = [...path, blackNf6, whiteNg5];

  it('buildReviewQueue serves actual prep cards, not stem moves', () => {
    const reviewEdges = edgesForOpeningFolder(folder, fresh, allRepEdges);
    const queue = buildReviewQueue(reviewEdges, false, 50);
    expect(queue.length).toBe(1);
    expect(queue[0].san).toBe('Ng5');
  });

  it('stem move e4 is not in the served queue', () => {
    const reviewEdges = edgesForOpeningFolder(folder, fresh, allRepEdges);
    const queue = buildReviewQueue(reviewEdges, false, 50);
    expect(queue.map(e => e.san)).not.toContain('e4');
  });
});

// ---------------------------------------------------------------------------
// Tests: user never asked to move opponent pieces when reviewing as White
// ---------------------------------------------------------------------------

describe('review as White — never asked to move Black pieces', () => {
  const { path, baseFen } = buildItalianScaffold();
  const folder = makeItalianFolder(path, baseFen);

  // Build a deeper line: 3...Bc5 4.c3 d6 5.d4 — White plays c3 and d4
  const blackBc5 = buildPrepEdge(baseFen, 'Bc5');
  const whiteC3  = buildPrepEdge(blackBc5.childFen, 'c3');
  const blackD6  = buildPrepEdge(whiteC3.childFen, 'd6');
  const whiteD4  = buildPrepEdge(blackD6.childFen, 'd4');

  const fresh = [whiteC3, whiteD4];  // non-scaffold White edges only
  const allRepEdges = [...path, blackBc5, whiteC3, blackD6, whiteD4];

  it('all review edges have mover=w', () => {
    const reviewEdges = edgesForOpeningFolder(folder, fresh, allRepEdges);
    for (const e of reviewEdges) {
      expect(e.mover).toBe('w');
    }
  });

  it('Black response edges (Bc5, d6) are never in the review queue', () => {
    const reviewEdges = edgesForOpeningFolder(folder, fresh, allRepEdges);
    const queue = buildReviewQueue(reviewEdges, false, 50);
    const sans = queue.map(e => e.san);
    expect(sans).not.toContain('Bc5');
    expect(sans).not.toContain('d6');
  });
});

// ---------------------------------------------------------------------------
// Tests: due count and served card count are consistent
// ---------------------------------------------------------------------------

describe('due count matches served cards', () => {
  const { path, baseFen } = buildItalianScaffold();
  const folder = makeItalianFolder(path, baseFen);

  const blackNf6 = buildPrepEdge(baseFen, 'Nf6');
  const whiteNg5 = buildPrepEdge(blackNf6.childFen, 'Ng5');
  const blackBc5 = buildPrepEdge(baseFen, 'Bc5');
  const whiteC3  = buildPrepEdge(blackBc5.childFen, 'c3');

  const fresh = [whiteNg5, whiteC3];
  const allRepEdges = [...path, blackNf6, whiteNg5, blackBc5, whiteC3];
  // allEdges for dueCount (same as allRepEdges here)
  const allEdges = allRepEdges;

  it('dueCount (non-scaffold White due edges in folder) equals served queue length', () => {
    // Simulate how dueCount is computed: use edgesForOpeningFolder with allEdges,
    // then filter by isTrainableEdge + isDue.
    const scopedEdges = edgesForOpeningFolder(folder, allEdges);
    const now = new Date();
    const dueCount = scopedEdges.filter(
      e => isTrainableEdge(e, 'w') && new Date(e.dueAt) <= now,
    ).length;

    // Simulate how review queue is built: use allRepEdges for navigation.
    const reviewEdges = edgesForOpeningFolder(folder, fresh, allRepEdges);
    const queue = buildReviewQueue(reviewEdges, false, 200);

    expect(queue.length).toBe(dueCount);
  });

  it('scaffold edges do not inflate the due count', () => {
    const scopedEdges = edgesForOpeningFolder(folder, allEdges);
    const now = new Date();
    const dueCount = scopedEdges.filter(
      e => isTrainableEdge(e, 'w') && new Date(e.dueAt) <= now,
    ).length;
    // Only whiteNg5 and whiteC3 are trainable White edges — exactly 2
    expect(dueCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildReviewQueue cap and fallback behaviour
// ---------------------------------------------------------------------------

describe('buildReviewQueue', () => {
  function makeEdgeWithDue(id: string, dueAt: string): Edge {
    const r = applyMove(STARTING_FEN_NORM, 'e4');
    if (!r) throw new Error();
    return makeEdge({ id, repertoireId: REP_ID, parentFen: STARTING_FEN_NORM, childFen: r.fen, san: 'e4', uci: r.uci, mover: 'w', dueAt });
  }

  it('returns at most cap edges', () => {
    const edges = Array.from({ length: 10 }, (_, i) =>
      makeEdgeWithDue(`e${i}`, new Date(Date.now() - i * 1000).toISOString())
    );
    const queue = buildReviewQueue(edges, false, 3);
    expect(queue.length).toBe(3);
  });

  it('sorts due edges oldest-first', () => {
    const older = makeEdgeWithDue('old', new Date(Date.now() - 10000).toISOString());
    const newer = makeEdgeWithDue('new', new Date(Date.now() - 1000).toISOString());
    const queue = buildReviewQueue([newer, older], false, 10);
    expect(queue[0].id).toBe('old');
  });

  it('excludes future-due edges when includeFallback=false', () => {
    const future = makeEdgeWithDue('future', new Date(Date.now() + 86_400_000).toISOString());
    const past   = makeEdgeWithDue('past',   new Date(Date.now() - 1000).toISOString());
    const queue = buildReviewQueue([future, past], false, 10);
    expect(queue.map(e => e.id)).toContain('past');
    expect(queue.map(e => e.id)).not.toContain('future');
  });
});
