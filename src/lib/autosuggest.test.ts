import { describe, it, expect } from 'vitest';
import { expectedScoreFromWdl, maxAllowedDropPawns, TUNING, type WdlVec } from './autosuggest';

describe('maxAllowedDropPawns', () => {
  it('returns 0.5 for the strict bucket (start <= 1.0)', () => {
    expect(maxAllowedDropPawns(0)).toBe(0.5);
    expect(maxAllowedDropPawns(0.5)).toBe(0.5);
    expect(maxAllowedDropPawns(1)).toBe(0.5);
  });

  it('returns 0.75 for the 1-3 bucket', () => {
    expect(maxAllowedDropPawns(1.01)).toBe(0.75);
    expect(maxAllowedDropPawns(2)).toBe(0.75);
    expect(maxAllowedDropPawns(3)).toBe(0.75);
  });

  it('returns 1.0 for the 3-4 bucket', () => {
    expect(maxAllowedDropPawns(3.01)).toBe(1.0);
    expect(maxAllowedDropPawns(4)).toBe(1.0);
  });

  it('returns 2.0 for the 4-5 bucket', () => {
    expect(maxAllowedDropPawns(4.01)).toBe(2.0);
    expect(maxAllowedDropPawns(5)).toBe(2.0);
  });

  it('returns 3.0 for the > 5 bucket', () => {
    expect(maxAllowedDropPawns(5.01)).toBe(3.0);
    expect(maxAllowedDropPawns(10)).toBe(3.0);
    expect(maxAllowedDropPawns(99)).toBe(3.0);
  });

  it('treats negative starting evals as bucket 0 (strictest threshold)', () => {
    expect(maxAllowedDropPawns(-0.5)).toBe(0.5);
    expect(maxAllowedDropPawns(-3)).toBe(0.5);
    expect(maxAllowedDropPawns(-100)).toBe(0.5);
  });
});

describe('expectedScoreFromWdl', () => {
  it('returns 500 for a balanced position', () => {
    expect(expectedScoreFromWdl({ win: 250, draw: 500, loss: 250 })).toBe(500);
  });

  it('returns 1000 for a forced win', () => {
    expect(expectedScoreFromWdl({ win: 1000, draw: 0, loss: 0 })).toBe(1000);
  });

  it('returns 0 for a forced loss', () => {
    expect(expectedScoreFromWdl({ win: 0, draw: 0, loss: 1000 })).toBe(0);
  });

  it('treats a draw as worth half a win', () => {
    expect(expectedScoreFromWdl({ win: 0, draw: 1000, loss: 0 })).toBe(500);
  });

  it('weights win and half-draw additively', () => {
    expect(expectedScoreFromWdl({ win: 600, draw: 300, loss: 100 })).toBe(750);
    expect(expectedScoreFromWdl({ win: 100, draw: 800, loss: 100 })).toBe(500);
  });
});

// The quality-gate logic itself is integration-heavy (depends on the engine),
// but the per-mille drop math at the threshold boundary is easy to assert by
// computing the same expressions the gate uses.
describe('WDL gate boundary math', () => {
  // Sample best/played WDLs that put the per-move computation on either side of
  // the gate's default thresholds. The gate fails iff expectedDrop > maxWdl OR
  // lossDelta > maxLossDelta — strictly greater than, equality passes.
  const best: WdlVec = { win: 350, draw: 500, loss: 150 }; // expected = 600
  const equalPlayed: WdlVec = { win: 350, draw: 500, loss: 150 };

  it('equal WDL → zero drop, gate passes', () => {
    const drop = expectedScoreFromWdl(best) - expectedScoreFromWdl(equalPlayed);
    const lossDelta = equalPlayed.loss - best.loss;
    expect(drop).toBe(0);
    expect(lossDelta).toBe(0);
    expect(drop > TUNING.maxWdlExpectedScoreDrop).toBe(false);
    expect(lossDelta > TUNING.maxWdlLossDelta).toBe(false);
  });

  it('expected-score drop at the limit (=35) passes (strictly greater fails)', () => {
    // Build a played WDL with expected = 565 (drop = 35), same loss as best
    const played: WdlVec = { win: 280, draw: 570, loss: 150 };
    const drop = expectedScoreFromWdl(best) - expectedScoreFromWdl(played);
    const lossDelta = played.loss - best.loss;
    expect(drop).toBe(35);
    expect(lossDelta).toBe(0);
    expect(drop > TUNING.maxWdlExpectedScoreDrop).toBe(false);
  });

  it('expected-score drop slightly above 35 fails the gate', () => {
    // Played WDL with expected = 564 (drop = 36)
    const played: WdlVec = { win: 278, draw: 572, loss: 150 };
    const drop = expectedScoreFromWdl(best) - expectedScoreFromWdl(played);
    expect(drop).toBe(36);
    expect(drop > TUNING.maxWdlExpectedScoreDrop).toBe(true);
  });

  it('loss-delta above 35 fails even when expected-drop is small', () => {
    // Played WDL where loss rose by 50 but expected only dropped by 10
    const played: WdlVec = { win: 340, draw: 460, loss: 200 };
    const drop = expectedScoreFromWdl(best) - expectedScoreFromWdl(played);
    const lossDelta = played.loss - best.loss;
    expect(drop).toBeLessThanOrEqual(TUNING.maxWdlExpectedScoreDrop);
    expect(lossDelta).toBe(50);
    expect(lossDelta > TUNING.maxWdlLossDelta).toBe(true);
  });

  it('cp-loss fallback uses 100cp = mistake threshold', () => {
    expect(TUNING.maxCpLossFallbackPerMove).toBe(100);
    // a 99cp loss passes, 101cp loss fails
    expect(99 > TUNING.maxCpLossFallbackPerMove).toBe(false);
    expect(101 > TUNING.maxCpLossFallbackPerMove).toBe(true);
  });
});
