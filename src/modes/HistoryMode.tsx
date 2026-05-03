import { useEffect, useMemo, useState } from 'react';
import { CHESS_HISTORY_CLOZE } from '../lib/chessHistory';
import {
  buildHistoryCardStates,
  freshHistoryProgress,
  getHistoryProgress,
  gradeHistory,
  historyCardId,
  isHistoryDue,
  nextDueLabel,
  saveHistoryProgress,
  type ProgressByCard,
} from '../lib/historySrs';

export interface HistoryModeProps {
  onProgressChange: () => void;
}

export function HistoryMode({ onProgressChange }: HistoryModeProps) {
  const [progressByCard, setProgressByCard] = useState<ProgressByCard>({});
  const [loaded, setLoaded] = useState(false);
  const [showAnswer, setShowAnswer] = useState(false);
  const [reviewedThisSession, setReviewedThisSession] = useState(0);
  const [cardOrder, setCardOrder] = useState<string[]>(() => randomHistoryOrder());

  useEffect(() => {
    (async () => {
      const saved = await getHistoryProgress();
      setProgressByCard(saved);
      setCardOrder(randomHistoryOrder());
      setLoaded(true);
    })();
  }, []);

  const now = useMemo(() => new Date(), [progressByCard]);
  const cardStats = useMemo(() => buildHistoryCardStates(progressByCard, now), [now, progressByCard]);
  const orderedCardStats = useMemo(() => {
    const order = new Map(cardOrder.map((id, index) => [id, index]));
    return [...cardStats].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }, [cardOrder, cardStats]);

  const dueCards = orderedCardStats.filter(item => isHistoryDue(item.progress, now));
  const newCards = orderedCardStats.filter(item => !progressByCard[item.id]);
  const learnedCount = cardStats.filter(item => item.progress.reps > 0 && !isHistoryDue(item.progress, now)).length;
  const active = dueCards[0] ?? newCards[0] ?? [...cardStats].sort((a, b) => a.progress.dueAt.localeCompare(b.progress.dueAt))[0];

  async function grade(cardIdToGrade: string, known: boolean) {
    const current = progressByCard[cardIdToGrade] ?? freshHistoryProgress();
    const next = gradeHistory(current, known ? 'known' : 'unknown');
    const updated = { ...progressByCard, [cardIdToGrade]: next };
    setProgressByCard(updated);
    setShowAnswer(false);
    setReviewedThisSession(n => n + 1);
    await saveHistoryProgress(updated);
    onProgressChange();
  }

  async function resetProgress() {
    if (!window.confirm('Reset chess trivia card progress?')) return;
    setProgressByCard({});
    setShowAnswer(false);
    setReviewedThisSession(0);
    setCardOrder(randomHistoryOrder());
    await saveHistoryProgress({});
    onProgressChange();
  }

  if (!loaded) return null;

  const [before, after] = active.card.prompt.split('{{C1}}');
  const activeDue = isHistoryDue(active.progress, now);

  return (
    <div className="layout history-layout">
      <div className="panel history-study-panel">
        <div className="row">
          <h3>Chess trivia</h3>
          <span className="spacer" />
          <button onClick={resetProgress}>Reset</button>
        </div>
        <div className="history-card">
          <div className="muted small">
            {activeDue ? 'Due now' : `Next review in ${nextDueLabel(active.progress, now)}`}
          </div>
          <div className="cloze-prompt">
            {before}
            <button
              className={'cloze-blank history-answer' + (showAnswer ? ' revealed' : '')}
              onClick={() => setShowAnswer(answer => !answer)}
              title="Click to pin answer"
            >
              {active.card.answer}
            </button>
            {after}
          </div>
          <div className="row history-actions">
            <button className="primary" onClick={() => grade(active.id, true)}>Did know</button>
            <button onClick={() => grade(active.id, false)}>Didn't know that</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>Progress</h3>
        <div className="history-stats">
          <div><strong>{dueCards.length}</strong><span className="muted small"> due</span></div>
          <div><strong>{learnedCount}</strong><span className="muted small"> remembered</span></div>
          <div><strong>{reviewedThisSession}</strong><span className="muted small"> today</span></div>
        </div>
        <div className="history-list">
          {cardStats.map(item => (
            <div key={item.id} className="history-list-row">
              <span className={'history-dot' + (isHistoryDue(item.progress, now) ? ' due' : item.progress.reps > 0 ? ' known' : '')} />
              <span>{item.card.answer}</span>
              <span className="spacer" />
              <span className="muted small">
                {item.progress.reps > 0 ? `${item.progress.reps}x · ${nextDueLabel(item.progress, now)}` : 'new'}
              </span>
            </div>
          ))}
        </div>
        <div className="muted small history-total">{CHESS_HISTORY_CLOZE.length} cards loaded</div>
      </div>
    </div>
  );
}

function randomHistoryOrder(): string[] {
  const ids = CHESS_HISTORY_CLOZE.map(historyCardId);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}
