import { useState } from 'react';
import type { Color, Edge, Repertoire } from '../types';
import { reviewGamePgn, type GameReviewResult, type ReviewMoment } from '../lib/gameReview';
import { playMoveInRepertoire, putEdge } from '../lib/storage';
import type { YourMovePick } from '../lib/autosuggest';

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

  async function analyze() {
    setLoading(true);
    setError(null);
    setResult(null);
    setAddedIds(new Set());
    try {
      setResult(await reviewGamePgn(repertoire, pgn, side));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

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
        <h3>Review game</h3>
        <div className="muted small settings-copy">
          Paste one PGN and Chesski will compare your moves to this repertoire, your ranked sources, and the engine.
        </div>
        <div className="row">
          <label className="small muted">Review as</label>
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
        {!result ? (
          <div className="muted">Paste a game to see where it diverged from your prep.</div>
        ) : (
          <>
            <div className="review-game-title">
              <strong>{result.white} vs {result.black}</strong>
              <span className="muted small">{result.result} · {result.reviewedMoves} of your opening moves checked</span>
            </div>
            {result.moments.length === 0 ? (
              <div className="account-status good small">No major opening issues found in the reviewed window.</div>
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
