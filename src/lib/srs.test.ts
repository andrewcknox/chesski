import { describe, expect, it } from 'vitest';
import type { Edge } from '../types';
import {
  DEFAULT_RELEARN_MINUTES,
  freshSrsState,
  gradeFail,
  gradeLearnPass,
  gradePass,
} from './srs';

function makeEdge(overrides: Partial<Edge> = {}): Edge {
  return {
    id: 'edge-1',
    repertoireId: 'rep-1',
    parentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    childFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    san: 'e4',
    uci: 'e2e4',
    mover: 'w',
    createdAt: '2026-01-01T12:00:00Z',
    ...freshSrsState(new Date('2026-01-01T12:00:00Z')),
    ...overrides,
  };
}

describe('gradeFail relearn scheduling', () => {
  it('defaults to DEFAULT_RELEARN_MINUTES from now', () => {
    const now = new Date('2026-05-21T12:00:00Z');
    const edge = makeEdge({ ease: 2.5, lapses: 0, reps: 5, intervalDays: 20 });
    const result = gradeFail(edge, { now });
    const expectedDue = new Date(now.getTime() + DEFAULT_RELEARN_MINUTES * 60_000).toISOString();
    expect(result.dueAt).toBe(expectedDue);
    expect(result.ease).toBeCloseTo(2.3);
    expect(result.lapses).toBe(1);
    expect(result.reps).toBe(0);
    expect(result.intervalDays).toBe(0);
  });

  it('honors a custom relearnMinutes', () => {
    const now = new Date('2026-05-21T12:00:00Z');
    const edge = makeEdge({ ease: 2.5 });
    expect(gradeFail(edge, { now, relearnMinutes: 1 }).dueAt)
      .toBe(new Date(now.getTime() + 60_000).toISOString());
    expect(gradeFail(edge, { now, relearnMinutes: 10 }).dueAt)
      .toBe(new Date(now.getTime() + 600_000).toISOString());
    expect(gradeFail(edge, { now, relearnMinutes: 60 }).dueAt)
      .toBe(new Date(now.getTime() + 3_600_000).toISOString());
  });

  it('floors ease at 1.3', () => {
    const now = new Date('2026-05-21T12:00:00Z');
    const edge = makeEdge({ ease: 1.4 });
    expect(gradeFail(edge, { now }).ease).toBeCloseTo(1.3);
    expect(gradeFail({ ...edge, ease: 1.3 }, { now }).ease).toBe(1.3);
  });
});

describe('gradeFail skipCompound', () => {
  it('refreshes dueAt but leaves ease/lapses/reps untouched', () => {
    const now = new Date('2026-05-21T12:00:00Z');
    const later = new Date('2026-05-21T12:03:00Z');
    // Simulate a card that was already failed earlier in the session.
    const failedOnce = gradeFail(makeEdge({ ease: 2.5, lapses: 0, reps: 5, intervalDays: 20 }), { now });
    expect(failedOnce.ease).toBeCloseTo(2.3);
    expect(failedOnce.lapses).toBe(1);

    const refreshed = gradeFail(failedOnce, { now: later, skipCompound: true });
    // dueAt refreshed from "later"
    expect(refreshed.dueAt).toBe(new Date(later.getTime() + DEFAULT_RELEARN_MINUTES * 60_000).toISOString());
    // ease unchanged (NOT 2.1)
    expect(refreshed.ease).toBeCloseTo(2.3);
    // lapses unchanged (NOT 2)
    expect(refreshed.lapses).toBe(1);
    // reps unchanged (already 0)
    expect(refreshed.reps).toBe(0);
    // lastReviewedAt does get updated
    expect(refreshed.lastReviewedAt).toBe(later.toISOString());
  });

  it('skipCompound honors custom relearnMinutes', () => {
    const now = new Date('2026-05-21T12:00:00Z');
    const edge = makeEdge();
    const refreshed = gradeFail(edge, { now, relearnMinutes: 15, skipCompound: true });
    expect(refreshed.dueAt).toBe(new Date(now.getTime() + 15 * 60_000).toISOString());
  });
});

describe('gradePass after gradeFail (multi-grade simulation)', () => {
  it('pass→fail leaves the card in fail state with ease dropped once', () => {
    const now = new Date('2026-05-21T12:00:00Z');
    const fail = new Date('2026-05-21T12:01:00Z');
    const edge = makeEdge({ ease: 2.5, reps: 1, lapses: 0, intervalDays: 1 });
    const passed = gradePass(edge, now);
    expect(passed.reps).toBe(2);
    expect(passed.intervalDays).toBe(3);
    const reFailed = gradeFail(passed, { now: fail });
    expect(reFailed.ease).toBeCloseTo(2.3);
    expect(reFailed.lapses).toBe(1);
    expect(reFailed.reps).toBe(0);
    expect(reFailed.dueAt).toBe(new Date(fail.getTime() + DEFAULT_RELEARN_MINUTES * 60_000).toISOString());
  });
});

describe('gradeLearnPass and gradePass interaction', () => {
  it('gradeLearnPass keeps dueAt at now and bumps reps', () => {
    const now = new Date('2026-05-21T12:00:00Z');
    const edge = makeEdge();
    const result = gradeLearnPass(edge, now);
    expect(result.reps).toBe(1);
    expect(result.dueAt).toBe(now.toISOString());
    expect(result.intervalDays).toBe(0);
  });
});
