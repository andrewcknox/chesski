import { describe, expect, it } from 'vitest';
import type { Edge, NormFen } from '../types';
import { applyMove, STARTING_FEN_NORM, turnAt } from './chess';
import { buildPreparedLineItems } from './viewLines';

const REP_ID = 'rep-view-lines';
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

function play(path: Edge[], fen: NormFen, move: string, isScaffold = false): { edge: Edge; fen: NormFen } {
  const applied = applyMove(fen, move);
  if (!applied) throw new Error(`Cannot play ${move}`);
  const edge = makeEdge({
    parentFen: fen,
    childFen: applied.fen,
    san: applied.san,
    uci: applied.uci,
    mover: applied.mover,
    isScaffold,
  });
  path.push(edge);
  return { edge, fen: applied.fen };
}

describe('buildPreparedLineItems', () => {
  it('collapses unanswered opponent moves to Black prepared endpoints in the Alekhine', () => {
    const edges: Edge[] = [];
    let fen = STARTING_FEN_NORM;
    ({ fen } = play(edges, fen, 'e4', true));
    const nf6 = play(edges, fen, 'Nf6', true);
    fen = nf6.fen;
    play(edges, fen, 'e5');

    const lines = buildPreparedLineItems(STARTING_FEN_NORM, edges, 'b');
    expect(lines).toHaveLength(1);
    expect(lines[0].leafFen).toBe(nf6.fen);
    expect(turnAt(lines[0].leafFen)).toBe('w');
    expect(lines[0].fullSan).toBe('1. e4 Nf6');
  });

  it('deduplicates several unanswered branches behind the same prepared response', () => {
    const edges: Edge[] = [];
    let fen = STARTING_FEN_NORM;
    ({ fen } = play(edges, fen, 'e4', true));
    const nf6 = play(edges, fen, 'Nf6', true);
    play(edges, nf6.fen, 'e5');
    play(edges, nf6.fen, 'Nc3');

    const lines = buildPreparedLineItems(STARTING_FEN_NORM, edges, 'b');
    expect(lines).toHaveLength(1);
    expect(lines[0].leafFen).toBe(nf6.fen);
  });

  it('keeps the deepest prepared response when a line continues beyond it', () => {
    const edges: Edge[] = [];
    let fen = STARTING_FEN_NORM;
    ({ fen } = play(edges, fen, 'e4', true));
    ({ fen } = play(edges, fen, 'Nf6', true));
    ({ fen } = play(edges, fen, 'e5'));
    const nd5 = play(edges, fen, 'Nd5');
    play(edges, nd5.fen, 'd4');

    const lines = buildPreparedLineItems(STARTING_FEN_NORM, edges, 'b');
    expect(lines).toHaveLength(1);
    expect(lines[0].leafFen).toBe(nd5.fen);
    expect(turnAt(lines[0].leafFen)).toBe('w');
    expect(lines[0].fullSan).toBe('1. e4 Nf6 2. e5 Nd5');
  });

  it('retains a full SAN label when the endpoint itself is ECO-named', () => {
    const edges: Edge[] = [];
    let fen = STARTING_FEN_NORM;
    ({ fen } = play(edges, fen, 'e4', true));
    const nf6 = play(edges, fen, 'Nf6', true);

    const lines = buildPreparedLineItems(STARTING_FEN_NORM, edges, 'b', (pos) =>
      pos === nf6.fen ? { eco: 'B02', name: 'Alekhine Defense' } : null
    );
    expect(lines[0].extensionSan).toBe('');
    expect(lines[0].fullSan).toBe('1. e4 Nf6');
  });

  it('does not recurse forever when malformed data loops back to an earlier FEN', () => {
    const e4Fen = applyMove(STARTING_FEN_NORM, 'e4')!.fen;
    const edges: Edge[] = [
      makeEdge({
        id: 'start-e4',
        parentFen: STARTING_FEN_NORM,
        childFen: e4Fen,
        san: 'e4',
        uci: 'e2e4',
        mover: 'w',
      }),
      makeEdge({
        id: 'loop-home',
        parentFen: e4Fen,
        childFen: STARTING_FEN_NORM,
        san: 'Loop',
        uci: 'e7e5',
        mover: 'b',
      }),
    ];

    const lines = buildPreparedLineItems(STARTING_FEN_NORM, edges, 'w');
    expect(lines).toHaveLength(1);
    expect(lines[0].leafFen).toBe(e4Fen);
    expect(lines[0].fullSan).toBe('1. e4');
  });
});
