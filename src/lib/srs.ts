import type { Edge } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;

export function endOfTodayISO(now = new Date()): string {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

export function addDaysISO(days: number, now = new Date()): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

export function isDue(edge: Edge, now = new Date()): boolean {
  return new Date(edge.dueAt).getTime() <= now.getTime();
}

// SM-2 pass: schedule forward.
export function gradePass(edge: Edge, now = new Date()): Edge {
  let interval: number;
  if (edge.reps === 0) interval = 1;
  else if (edge.reps === 1) interval = 3;
  else interval = Math.round(edge.intervalDays * edge.ease);
  return {
    ...edge,
    reps: edge.reps + 1,
    intervalDays: interval,
    dueAt: addDaysISO(interval, now),
    lastReviewedAt: now.toISOString(),
  };
}

// Learning pass: mark the card as learned, but keep it due today so it can be reviewed
// again in the same session/day.
export function gradeLearnPass(edge: Edge, now = new Date()): Edge {
  return {
    ...edge,
    reps: edge.reps + 1,
    intervalDays: 0,
    dueAt: now.toISOString(),
    lastReviewedAt: now.toISOString(),
  };
}

// SM-2 fail: drop ease, reset reps, requeue today.
export function gradeFail(edge: Edge, now = new Date()): Edge {
  return {
    ...edge,
    ease: Math.max(1.3, edge.ease - 0.2),
    reps: 0,
    lapses: edge.lapses + 1,
    intervalDays: 0,
    dueAt: endOfTodayISO(now),
    lastReviewedAt: now.toISOString(),
  };
}

export function freshSrsState(now = new Date()): Pick<Edge, 'ease' | 'intervalDays' | 'reps' | 'lapses' | 'dueAt' | 'lastReviewedAt'> {
  return {
    ease: 2.5,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    dueAt: now.toISOString(),
    lastReviewedAt: null,
  };
}
