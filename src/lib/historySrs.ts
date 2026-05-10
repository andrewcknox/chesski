import { CHESS_HISTORY_CLOZE, type HistoryClozeCard } from './chessHistory';
import { addDaysISO } from './srs';
import { getMeta, setMeta } from './storage';

export const META_HISTORY_PROGRESS = 'history_srs_progress_v1';
const WRONG_COOLDOWN_MS = 3 * 60 * 1000;

export interface HistoryProgress {
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  dueAt: string;
  lastReviewedAt: string | null;
}

export type ProgressByCard = Record<string, HistoryProgress>;
export type HistoryGrade = 'known' | 'unknown';

export interface HistoryCardState {
  card: HistoryClozeCard;
  id: string;
  progress: HistoryProgress;
}

export function historyCardId(card: HistoryClozeCard): string {
  if (!card.kind || card.kind === 'history') return `${card.prompt}::${card.answer ?? ''}`;
  const answers = (card.clozes ?? [{ answer: card.answer ?? '' }]).map(cloze => cloze.answer).join('::');
  return `${card.kind}::${card.prompt}::${answers}`;
}

export function freshHistoryProgress(now = new Date()): HistoryProgress {
  return {
    ease: 2.5,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    dueAt: now.toISOString(),
    lastReviewedAt: null,
  };
}

export function isHistoryDue(progress: HistoryProgress, now = new Date()): boolean {
  return new Date(progress.dueAt).getTime() <= now.getTime();
}

export function gradeHistory(progress: HistoryProgress, grade: HistoryGrade, now = new Date()): HistoryProgress {
  if (grade === 'unknown') {
    return {
      ...progress,
      ease: Math.max(1.3, progress.ease - 0.2),
      intervalDays: 0,
      reps: 0,
      lapses: progress.lapses + 1,
      dueAt: new Date(now.getTime() + WRONG_COOLDOWN_MS).toISOString(),
      lastReviewedAt: now.toISOString(),
    };
  }

  let intervalDays: number;
  if (progress.reps === 0) intervalDays = 1;
  else if (progress.reps === 1) intervalDays = 3;
  else intervalDays = Math.max(4, Math.round(progress.intervalDays * progress.ease));
  return {
    ...progress,
    reps: progress.reps + 1,
    intervalDays,
    dueAt: addDaysISO(intervalDays, now),
    lastReviewedAt: now.toISOString(),
  };
}

export async function getHistoryProgress(): Promise<ProgressByCard> {
  return (await getMeta<ProgressByCard>(META_HISTORY_PROGRESS)) ?? {};
}

export async function saveHistoryProgress(progress: ProgressByCard): Promise<void> {
  await setMeta(META_HISTORY_PROGRESS, progress);
}

export function buildHistoryCardStates(progressByCard: ProgressByCard, now = new Date()): HistoryCardState[] {
  return CHESS_HISTORY_CLOZE.map(card => {
    const id = historyCardId(card);
    return { card, id, progress: progressByCard[id] ?? freshHistoryProgress(now) };
  });
}

export async function getHistoryDueCount(now = new Date()): Promise<number> {
  const progress = await getHistoryProgress();
  return buildHistoryCardStates(progress, now).filter(item => isHistoryDue(item.progress, now)).length;
}

export function nextDueLabel(progress: HistoryProgress, now = new Date()): string {
  if (isHistoryDue(progress, now)) return 'due now';
  const due = new Date(progress.dueAt);
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays <= 1) return 'tomorrow';
  return `${diffDays} days`;
}
