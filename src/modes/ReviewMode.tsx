import { useEffect, useState } from 'react';
import { ClozePrompt } from '../components/ClozePrompt';
import type { Color, Edge, Repertoire } from '../types';
import { reviewGamePgn, type GameReviewResult, type ReviewMoment } from '../lib/gameReview';
import { playMoveInRepertoire, putEdge } from '../lib/storage';
import type { YourMovePick } from '../lib/autosuggest';
import {
  buildHistoryCardStates,
  freshHistoryProgress,
  getHistoryProgress,
  gradeHistory,
  isHistoryDue,
  saveHistoryProgress,
  type HistoryCardState,
  type ProgressByCard,
} from '../lib/historySrs';

export function ReviewMode({ repertoire, onDataChange }: {
  repertoire: Repertoire;
  onDataChange: () => void;
}) {
  const [pgn, setPgn] = useState('');
  const [side, setSide] = useState<Color>(repertoire.color);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GameReviewResult | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [historyProgress, setHistoryProgress] = useState<ProgressByCard>({});
  const [historyAnswerShown, setHistoryAnswerShown] = useState(false);

  useEffect(() => {
    (async () => setHistoryProgress(await getHistoryProgress()))();
  }, []);

  async function analyze() {
    setLoading(true);
    setError(null);
    setResult(null);
    setAddedIds(new Set());
    setHistoryAnswerShown(false);
    try {
      setResult(await reviewGamePgn(repertoire, pgn, side));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function gradeHistoryCard(cardId: string, knewIt: boolean) {
    const current = historyProgress[cardId] ?? freshHistoryProgress();
    const updated = { ...historyProgress, [cardId]: gradeHistory(current, knewIt ? 'known' : 'unknown') };
    setHistoryProgress(updated);
    setHistoryAnswerShown(false);
    await saveHistoryProgress(updated);
    onDataChange();
  }

  const loadingCard = chooseReviewHistoryCard(historyProgress);

  async function addSuggestion(moment: ReviewMoment) {
    if (!moment.suggestion) return;
    const added = await playMoveInRepertoire(repertoire.id, moment.fen, uciToMove(moment.suggestion.uci));
    if (!added) {
      setError('Could not add that move from this position.');
      return;
    }
    await attachSuggestionSource(added.edge, moment.suggestion);
    setAddedIds(prev => new Set([...prev, moment.id]));
    onDataChange();
  }

  return (
    <div className="layout review-layout">
      <div className="panel">
        <h3>Analyze my game</h3>
        <div className="muted small settings-copy">
          Paste one PGN and Chesski will compare your moves to this repertoire, your ranked sources, and the engine.
        </div>
        <div className="row">
          <label className="small muted">Analyze as</label>
          <select value={side} onChange={e => setSide(e.target.value as Color)}>
            <option value="w">White</option>
            <option value="b">Black</option>
          </select>
          <button className="primary" onClick={analyze} disabled={loading || !pgn.trim()}>
            {loading ? 'Analyzing...' : 'Analyze PGN'}
          </button>
        </div>
        <textarea
          className="review-pgn-box"
          value={pgn}
          onChange={e => setPgn(e.target.value)}
          placeholder="Paste a PGN here"
        />
        {error && <div className="account-status bad small">{error}</div>}
      </div>

      <div className="panel">
        <h3>Findings</h3>
        {loading && loadingCard ? (
          <ReviewHistoryCard
            cardState={loadingCard}
            answerShown={historyAnswerShown}
            onToggleAnswer={() => setHistoryAnswerShown(shown => !shown)}
            onGrade={(knewIt) => void gradeHistoryCard(loadingCard.id, knewIt)}
          />
        ) : !result ? (
          <div className="muted">Paste a game to see where it diverged from your prep.</div>
        ) : (
          <>
            <div className="review-game-title">
              <strong>{result.white} vs {result.black}</strong>
              <span className="muted small">{result.result} · {result.reviewedMoves} of your opening moves checked</span>
            </div>
            {result.moments.length === 0 ? (
              <div className="account-status good small">No major opening issues found in the analyzed window.</div>
            ) : (
              <div className="review-moment-list">
                {result.moments.map(moment => (
                  <ReviewMomentCard
                    key={moment.id}
                    moment={moment}
                    added={addedIds.has(moment.id)}
                    onAdd={() => addSuggestion(moment)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function chooseReviewHistoryCard(progressByCard: ProgressByCard): HistoryCardState | null {
  const now = new Date();
  const cards = buildHistoryCardStates(progressByCard, now);
  if (cards.length === 0) return null;
  return cards
    .sort((a, b) => {
      const dueDelta = Number(isHistoryDue(b.progress, now)) - Number(isHistoryDue(a.progress, now));
      if (dueDelta !== 0) return dueDelta;
      const newDelta = Number(!progressByCard[b.id]) - Number(!progressByCard[a.id]);
      if (newDelta !== 0) return newDelta;
      return a.progress.dueAt.localeCompare(b.progress.dueAt);
    })[0];
}

function ReviewHistoryCard({ cardState, answerShown, onToggleAnswer, onGrade }: {
  cardState: HistoryCardState;
  answerShown: boolean;
  onToggleAnswer: () => void;
  onGrade: (knewIt: boolean) => void;
}) {
  return (
    <div className="cloze-card">
      <div className="muted small">While Chesski analyzes your game</div>
      <ClozePrompt card={cardState.card} answerShown={answerShown} onToggleAnswer={onToggleAnswer} />
      <div className="row history-actions">
        <button className="primary" onClick={() => onGrade(true)}>Knew it</button>
        <button onClick={() => onGrade(false)}>Couldn't pull it</button>
      </div>
    </div>
  );
}

function ReviewMomentCard({ moment, added, onAdd }: {
  moment: ReviewMoment;
  added: boolean;
  onAdd: () => void;
}) {
  const canAdd = Boolean(moment.suggestion && moment.inRepertoire);
  return (
    <div className={'review-moment-card' + (moment.isFirstSeriousMistake ? ' mistake' : '')}>
      <div className="review-moment-head">
        <strong>{moment.moveNumber}. {moment.playedSan}</strong>
        <span className="review-pill">{moment.reason}</span>
      </div>
      <div className="review-lines">
        <div><span className="muted small">You played</span> {moment.playedSan}</div>
        {moment.preparedSan && <div><span className="muted small">Prep says</span> {moment.preparedSan}</div>}
        {moment.cpLoss !== null && <div><span className="muted small">Engine loss</span> {Math.round(moment.cpLoss)} cp</div>}
        {moment.suggestion && (
          <div>
            <span className="muted small">Suggested</span> {moment.suggestion.san}
            <span className="muted small"> · {sourceLabel(moment.suggestion)}</span>
          </div>
        )}
      </div>
      {moment.suggestion && (
        <div className="row review-actions">
          <button onClick={onAdd} disabled={!canAdd || added}>
            {added ? 'Added' : 'Add suggestion'}
          </button>
          {!moment.inRepertoire && <span className="muted small">This position is outside the selected repertoire.</span>}
        </div>
      )}
    </div>
  );
}

function sourceLabel(pick: YourMovePick): string {
  if (pick.source === 'player-book') {
    const score = pick.playerWins !== undefined && pick.playerLosses !== undefined
      ? ` (${pick.playerWins}-${pick.playerDraws ?? 0}-${pick.playerLosses})`
      : '';
    return `${pick.playerName ?? 'Player book'}${score}`;
  }
  if (pick.source === 'masters') return 'Masters database';
  if (pick.source === 'lichess-2000') return 'Lichess 2000+ games';
  return 'Stockfish';
}

function uciToMove(uci: string): { from: string; to: string; promotion?: string } {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci.slice(4) : undefined,
  };
}

async function attachSuggestionSource(edge: Edge, pick: YourMovePick): Promise<void> {
  if (pick.source !== 'player-book') return;
  await putEdge({
    ...edge,
    recommendationSource: 'player-book',
    sourcePlayerName: pick.playerName,
    sourceGameName: pick.sourceGameName ?? undefined,
    sourceWins: pick.playerWins,
    sourceDraws: pick.playerDraws,
    sourceLosses: pick.playerLosses,
    sourceNet: pick.playerNet,
  });
}
