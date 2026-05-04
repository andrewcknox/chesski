import { useEffect, useMemo, useRef, useState } from 'react';
import { Board } from '../components/Board';
import { applyMove, STARTING_FEN_NORM } from '../lib/chess';
import {
  ALGORITHM_TOOLTIP,
  buildImportDraft,
  type ImportDraft,
  type ImportSource,
  type ImportSpeed,
  type RootDraft,
} from '../lib/gameImport';
import { addMovesToRepertoire, getRepertoire, markCuratedOpeningScaffolds } from '../lib/storage';
import type { Color, NormFen, Repertoire } from '../types';

export function GameImportMode({
  repertoires,
  activeRepId,
  onChanged,
  onOpen,
}: {
  repertoires: Repertoire[];
  activeRepId: string | null;
  onChanged: () => void | Promise<void>;
  onOpen: (id: string) => void;
}) {
  const [source, setSource] = useState<ImportSource>('chesscom');
  const [username, setUsername] = useState('');
  const [side, setSide] = useState<Color>('w');
  const [speeds, setSpeeds] = useState<ImportSpeed[]>(['blitz', 'rapid']);
  const [months, setMonths] = useState<number | 'all'>(12);
  const [pgn, setPgn] = useState('');
  const [threshold, setThreshold] = useState(75);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyStatus, setApplyStatus] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const compatibleReps = useMemo(
    () => repertoires.filter(rep => rep.color === side && (rep.projectKind ?? 'standard') !== 'siloed'),
    [repertoires, side]
  );
  const defaultTargetId = compatibleReps.find(rep => rep.id === activeRepId)?.id ?? compatibleReps[0]?.id ?? '';
  const [targetId, setTargetId] = useState(defaultTargetId);
  const target = compatibleReps.find(rep => rep.id === targetId) ?? compatibleReps[0] ?? null;

  useEffect(() => {
    if (compatibleReps.some(rep => rep.id === targetId)) return;
    setTargetId(defaultTargetId);
  }, [compatibleReps, defaultTargetId, targetId]);

  async function analyze() {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    setStatus('Starting import...');
    setError(null);
    setDraft(null);
    setApplyStatus(null);
    try {
      const nextDraft = await buildImportDraft({
        source,
        username,
        side,
        speeds,
        pgn,
        chessComMonths: months,
        cpLossThreshold: threshold,
        onStatus: setStatus,
        signal: abort.signal,
      });
      setDraft(nextDraft);
      setStatus(nextDraft.skippedReason ?? `Built ${nextDraft.roots.length} opening draft${nextDraft.roots.length === 1 ? '' : 's'}.`);
    } catch (err) {
      if (abort.signal.aborted) setStatus('Import cancelled.');
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      setBusy(false);
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  function toggleSpeed(speed: ImportSpeed) {
    setSpeeds(current => current.includes(speed)
      ? current.filter(item => item !== speed)
      : [...current, speed]
    );
  }

  async function applyDraft() {
    if (!draft || !target) return;
    setApplying(true);
    setError(null);
    setApplyStatus(null);
    try {
      const rep = await getRepertoire(target.id);
      if (!rep) throw new Error('Could not find that repertoire.');
      let added = 0;
      let reused = 0;
      for (const root of draft.roots) {
        for (const line of root.lines) {
          const result = await addMovesToRepertoire(rep, line, { scaffoldPlyCount: root.opening.moves.length });
          added += result.addedEdges;
          reused += result.reusedEdges;
        }
      }
      await markCuratedOpeningScaffolds(rep);
      await onChanged();
      setApplyStatus(`${added} moves added, ${reused} reused from ${draft.roots.length} opening draft${draft.roots.length === 1 ? '' : 's'}.`);
      onOpen(rep.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="layout import-layout">
      <div className="panel import-source-panel">
        <h3>Build From My Games</h3>
        <div className="muted small settings-copy">
          Chesski imports only the side and speeds you choose, maps those games onto the preset openings, and drafts transparent keep-or-replace recommendations.
        </div>

        <div className="segmented import-source-toggle">
          <button className={source === 'chesscom' ? 'active' : ''} onClick={() => setSource('chesscom')}>Chess.com</button>
          <button className={source === 'pgn' ? 'active' : ''} onClick={() => setSource('pgn')}>PGN</button>
        </div>

        <div className="import-form">
          <label>
            <span className="small muted">Username</span>
            <input value={username} onChange={e => setUsername(e.target.value)} placeholder={source === 'chesscom' ? 'Chess.com username' : 'Username in PGN headers'} />
          </label>

          <div className="import-control-row">
            <label>
              <span className="small muted">Side</span>
              <select value={side} onChange={e => setSide(e.target.value as Color)}>
                <option value="w">White games only</option>
                <option value="b">Black games only</option>
              </select>
            </label>
            {source === 'chesscom' && (
              <label>
                <span className="small muted">Archives</span>
                <select value={String(months)} onChange={e => setMonths(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
                  <option value="6">Last 6 months</option>
                  <option value="12">Last 12 months</option>
                  <option value="24">Last 24 months</option>
                  <option value="all">All archives</option>
                </select>
              </label>
            )}
          </div>

          <div>
            <div className="small muted">Speeds</div>
            <div className="import-speed-row">
              {(['blitz', 'rapid', 'bullet'] as ImportSpeed[]).map(speed => (
                <label key={speed} className="import-check">
                  <input type="checkbox" checked={speeds.includes(speed)} onChange={() => toggleSpeed(speed)} />
                  <span>{speed}</span>
                </label>
              ))}
            </div>
          </div>

          <label>
            <span className="small muted">Max centipawn loss</span>
            <input
              type="number"
              min={0}
              max={300}
              step={5}
              value={threshold}
              onChange={e => setThreshold(Number(e.target.value) || 0)}
            />
          </label>

          {source === 'pgn' && (
            <textarea
              className="review-pgn-box import-pgn-box"
              value={pgn}
              onChange={e => setPgn(e.target.value)}
              placeholder="Paste one PGN or a file containing many PGNs"
            />
          )}

          <div className="row">
            <button className="primary" onClick={analyze} disabled={busy || speeds.length === 0 || (source === 'chesscom' && !username.trim()) || (source === 'pgn' && !pgn.trim())}>
              {busy ? 'Building...' : 'Build draft'}
            </button>
            {busy && <button onClick={cancel}>Cancel</button>}
          </div>
        </div>

        {status && <div className="account-status good small">{status}</div>}
        {error && <div className="account-status bad small">{error}</div>}
      </div>

      <div className="panel import-results-panel">
        <div className="import-results-head">
          <div>
            <h3>Draft</h3>
            {draft && (
              <div className="muted small">
                {draft.gamesImported} games imported · {draft.gamesMatched} reached a preset root · threshold {draft.cpLossThreshold} cp
              </div>
            )}
          </div>
          {draft && draft.roots.length > 0 && (
            <div className="import-apply-box">
              <select value={target?.id ?? ''} onChange={e => setTargetId(e.target.value)}>
                {compatibleReps.map(rep => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
              </select>
              <button className="primary" onClick={applyDraft} disabled={applying || !target}>
                {applying ? 'Adding...' : 'Add draft'}
              </button>
            </div>
          )}
        </div>

        {!draft ? (
          <div className="settings-empty-drop">Build a draft to see which openings Chesski can make from your games.</div>
        ) : draft.roots.length === 0 ? (
          <div className="settings-empty-drop">{draft.skippedReason ?? 'No draft lines yet.'}</div>
        ) : (
          <div className="import-root-list">
            {draft.roots.map(root => <RootDraftCard key={root.opening.key} root={root} />)}
          </div>
        )}

        {applyStatus && <div className="account-status good small">{applyStatus}</div>}
      </div>
    </div>
  );
}

function RootDraftCard({ root }: { root: RootDraft }) {
  const preview = previewFen(root.opening.moves);
  const replacements = root.decisions.filter(item => item.kind === 'replaced').length;
  return (
    <div className="import-root-card">
      <div className="import-root-board">
        <Board
          fen={preview}
          orientation={root.opening.color === 'w' ? 'white' : 'black'}
          onMove={() => false}
          allowMoves={false}
          size={104}
          showNotation={false}
        />
      </div>
      <div className="import-root-copy">
        <div className="import-root-title">
          <strong>{root.opening.name}</strong>
          <span>{root.gameCount} game{root.gameCount === 1 ? '' : 's'} · {root.lines.length} line{root.lines.length === 1 ? '' : 's'} · {replacements} replacement{replacements === 1 ? '' : 's'}</span>
        </div>
        <div className="import-line-preview mono">{root.lines.slice(0, 3).map(line => line.join(' ')).join('\n')}</div>
        <div className="import-decision-list">
          {root.decisions.slice(0, 5).map(decision => (
            <div key={decision.id} className={'import-decision ' + decision.kind}>
              {decision.kind === 'replaced' ? (
                <>
                  <span title={ALGORITHM_TOOLTIP} className="algorithm-label">Chesski's algorithm prefers this continuation</span>
                  <strong>{decision.chosenSan}</strong>
                  <span className="muted small">instead of {decision.playedSan} · {formatCp(decision.cpLoss)} · {decision.games} games</span>
                </>
              ) : (
                <>
                  <span>Kept</span>
                  <strong>{decision.chosenSan}</strong>
                  <span className="muted small">{formatCp(decision.cpLoss)} · {decision.masterGames} master games · {decision.games} games</span>
                </>
              )}
              <div className="muted small">{decision.reason}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function previewFen(moves: string[]): NormFen {
  let fen = STARTING_FEN_NORM;
  for (const move of moves) {
    const result = applyMove(fen, move);
    if (!result) break;
    fen = result.fen;
  }
  return fen;
}

function formatCp(cpLoss: number | null): string {
  return cpLoss === null ? 'no eval' : `${Math.round(cpLoss)} cp`;
}
