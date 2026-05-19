import { useEffect, useMemo, useRef, useState } from 'react';
import { Board } from '../components/Board';
import { applyMove, STARTING_FEN_NORM } from '../lib/chess';
import {
  ALGORITHM_TOOLTIP,
  buildImportDraft,
  resolvePlayerConflict,
  type ConflictMoveStats,
  type ImportDraft,
  type ImportSource,
  type ImportSpeed,
  type RootDraft,
} from '../lib/gameImport';
import { rememberImportDraft } from '../lib/importMemory';
import { prepareOpeningLineForRepertoire } from '../lib/openingRoots';
import { getEdgesFromParent, getRepertoire, markCuratedOpeningScaffolds, playMoveInRepertoire, swapMoveInRepertoire } from '../lib/storage';
import type { Color, NormFen, Repertoire } from '../types';
import { ConflictResolveModal } from './ConflictResolveModal';

const DEFAULT_PREP_PROMPT_THRESHOLD = 5;

interface ConflictPrompt {
  fen: NormFen;
  color: Color;
  existing: ConflictMoveStats;
  candidate: ConflictMoveStats;
  algorithmPickSan: string | null;
  reason: string;
}

interface LineApplyOutcome {
  addedEdges: number;
  reusedEdges: number;
  cancelled: boolean;
  skippedAtSan?: string;
}

async function applyLineWithConflictResolution(args: {
  rep: Repertoire;
  moves: string[];
  scaffoldPlyCount: number;
  cpLossThreshold: number;
  decisions: Map<string, 'existing' | 'new'>;
  askConflict: (prompt: ConflictPrompt) => Promise<'existing' | 'new' | 'cancel'>;
}): Promise<LineApplyOutcome> {
  const { rep, moves, scaffoldPlyCount, cpLossThreshold, decisions, askConflict } = args;
  let cursorFen: NormFen = rep.rootFen;
  let added = 0;
  let reused = 0;
  for (const [idx, move] of moves.entries()) {
    const result = applyMove(cursorFen, move);
    if (!result) throw new Error(`Could not add move ${move} from this position.`);
    const isScaffold = idx < scaffoldPlyCount;
    const isPlayerMove = result.mover === rep.color;

    if (isPlayerMove && !isScaffold && cursorFen !== rep.rootFen) {
      const existingEdges = await getEdgesFromParent(rep.id, cursorFen);
      const conflictingExisting = existingEdges.find(e => e.mover === rep.color && !e.isScaffold && e.uci !== result.uci);
      if (conflictingExisting) {
        const key = `${cursorFen}|${conflictingExisting.uci}|${result.uci}`;
        let decision = decisions.get(key);
        if (!decision) {
          const resolved = await resolvePlayerConflict(cursorFen, rep.color, conflictingExisting.uci, result.uci, cpLossThreshold);
          if (resolved.decision === 'existing' || resolved.decision === 'new') {
            decision = resolved.decision;
          } else {
            const choice = await askConflict({
              fen: cursorFen,
              color: rep.color,
              existing: resolved.existingStats,
              candidate: resolved.newStats,
              algorithmPickSan: resolved.algorithmPickSan,
              reason: resolved.reason,
            });
            if (choice === 'cancel') return { addedEdges: added, reusedEdges: reused, cancelled: true };
            decision = choice;
          }
          decisions.set(key, decision);
        }
        if (decision === 'existing') {
          // Stop this line at the conflict — keep existing prep intact.
          return { addedEdges: added, reusedEdges: reused, cancelled: false, skippedAtSan: result.san };
        }
        // decision === 'new': swap the conflicting edge for the new move, then continue.
        await swapMoveInRepertoire(rep.id, cursorFen, conflictingExisting.childFen, move);
        added += 1;
        cursorFen = result.fen;
        continue;
      }
    }

    const played = await playMoveInRepertoire(rep.id, cursorFen, move, { isScaffold });
    if (!played) throw new Error(`Could not add move ${move} from this position.`);
    if (played.edgeCreated) added += 1;
    else reused += 1;
    cursorFen = played.edge.childFen;
  }
  return { addedEdges: added, reusedEdges: reused, cancelled: false };
}

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
  const [gameLimit, setGameLimit] = useState(500);
  const [pgn, setPgn] = useState('');
  const [threshold, setThreshold] = useState(75);
  const [prepPromptThreshold, setPrepPromptThreshold] = useState(DEFAULT_PREP_PROMPT_THRESHOLD);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [selectedRootKey, setSelectedRootKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyStatus, setApplyStatus] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const conflictResolverRef = useRef<((c: 'existing' | 'new' | 'cancel') => void) | null>(null);
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
    setSelectedRootKey(null);
    setApplyStatus(null);
    try {
      const nextDraft = await buildImportDraft({
        source,
        username,
        side,
        speeds,
        pgn,
        chessComMonths: months,
        gameLimit,
        cpLossThreshold: threshold,
        onStatus: setStatus,
        signal: abort.signal,
      });
      await rememberImportDraft(nextDraft, source);
      const recommended = nextDraft.roots.filter(root => root.gameCount >= prepPromptThreshold && root.lines.length > 0);
      const storedCount = nextDraft.roots.filter(root => root.lines.length > 0).length;
      setDraft(nextDraft);
      setSelectedRootKey(recommended[0]?.opening.key ?? null);
      setStatus(nextDraft.skippedReason ?? `Saved ${storedCount} opening histor${storedCount === 1 ? 'y' : 'ies'}. ${recommended.length} met the ${prepPromptThreshold}-game study threshold.`);
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

  async function askConflict(prompt: ConflictPrompt): Promise<'existing' | 'new' | 'cancel'> {
    return new Promise(resolve => {
      conflictResolverRef.current = resolve;
      setConflict(prompt);
    });
  }

  function resolveConflict(choice: 'existing' | 'new' | 'cancel') {
    const resolver = conflictResolverRef.current;
    conflictResolverRef.current = null;
    setConflict(null);
    resolver?.(choice);
  }

  async function applyDraft(rootKey = selectedRootKey) {
    if (!draft || !target || !rootKey) return;
    const root = draft.roots.find(item => item.opening.key === rootKey);
    if (!root) return;
    setApplying(true);
    setError(null);
    setApplyStatus(null);
    const playerConflictDecisions = new Map<string, 'existing' | 'new'>(); // key: parentFen|existingUci|newUci
    const skippedLines: string[] = [];
    let cancelled = false;
    try {
      const rep = await getRepertoire(target.id);
      if (!rep) throw new Error('Could not find that repertoire.');
      let added = 0;
      let reused = 0;
      for (const line of root.lines) {
        if (cancelled) break;
        const prepared = prepareOpeningLineForRepertoire(rep, root.opening, line);
        if (prepared.moves.length === 0) continue;
        const outcome = await applyLineWithConflictResolution({
          rep,
          moves: prepared.moves,
          scaffoldPlyCount: prepared.scaffoldPlyCount,
          cpLossThreshold: draft.cpLossThreshold,
          decisions: playerConflictDecisions,
          askConflict,
        });
        if (outcome.cancelled) { cancelled = true; break; }
        added += outcome.addedEdges;
        reused += outcome.reusedEdges;
        if (outcome.skippedAtSan) skippedLines.push(`${line.join(' ')} (stopped at ${outcome.skippedAtSan})`);
      }
      await markCuratedOpeningScaffolds(rep);
      await onChanged();
      if (cancelled) {
        setError('Apply cancelled.');
      } else {
        const skipNote = skippedLines.length > 0
          ? ` ${skippedLines.length} line${skippedLines.length === 1 ? '' : 's'} were trimmed at a conflict point.`
          : '';
        setApplyStatus(`${root.opening.name}: ${added} moves added, ${reused} reused.${skipNote} The other imported openings are saved for later.`);
        onOpen(rep.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      conflictResolverRef.current = null;
      setConflict(null);
      setApplying(false);
    }
  }

  return (
    <div className="layout import-layout">
      <div className="panel import-source-panel">
        <div className="eyebrow">Games</div>
        <h2>Build from games</h2>
        <div className="muted small settings-copy">
          Import games to find openings worth studying.
        </div>

        <div className="segmented import-source-toggle">
          <button className={source === 'chesscom' ? 'active' : ''} onClick={() => setSource('chesscom')}>Chess.com</button>
          <button className={source === 'lichess' ? 'active' : ''} onClick={() => setSource('lichess')}>Lichess</button>
          <button className={source === 'pgn' ? 'active' : ''} onClick={() => setSource('pgn')}>PGN</button>
        </div>

        <div className="import-form">
          <label>
            <span className="small muted">Username</span>
            <input value={username} onChange={e => setUsername(e.target.value)} placeholder={usernamePlaceholder(source)} />
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
            {source === 'lichess' && (
              <label>
                <span className="small muted">Game limit</span>
                <select value={String(gameLimit)} onChange={e => setGameLimit(Number(e.target.value))}>
                  <option value="100">Latest 100 games</option>
                  <option value="250">Latest 250 games</option>
                  <option value="500">Latest 500 games</option>
                  <option value="1000">Latest 1000 games</option>
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

          <label>
            <span className="small muted">Study prompt threshold</span>
            <input
              type="number"
              min={1}
              max={50}
              step={1}
              value={prepPromptThreshold}
              onChange={e => setPrepPromptThreshold(Math.max(1, Number(e.target.value) || DEFAULT_PREP_PROMPT_THRESHOLD))}
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
            <button className="primary" onClick={analyze} disabled={busy || speeds.length === 0 || (source !== 'pgn' && !username.trim()) || (source === 'pgn' && !pgn.trim())}>
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
          {draft && draft.roots.some(root => root.gameCount >= prepPromptThreshold && root.lines.length > 0) && (
            <div className="import-apply-box">
              <select value={target?.id ?? ''} onChange={e => setTargetId(e.target.value)}>
                {compatibleReps.map(rep => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
              </select>
              <button className="primary" onClick={() => void applyDraft()} disabled={applying || !target || !selectedRootKey}>
                {applying ? 'Adding...' : 'Study selected'}
              </button>
            </div>
          )}
        </div>

        {!draft ? (
          <div className="settings-empty-drop empty-state">Import games to find openings worth studying.</div>
        ) : draft.roots.length === 0 ? (
          <div className="settings-empty-drop empty-state">{draft.skippedReason ?? 'No imported games yet.'}</div>
        ) : (
          <>
            <OpeningPromptList
              roots={draft.roots.filter(root => root.gameCount >= prepPromptThreshold && root.lines.length > 0)}
              selectedRootKey={selectedRootKey}
              onSelect={setSelectedRootKey}
            />
            <div className="import-root-list">
              {draft.roots.map(root => (
                <RootDraftCard
                  key={root.opening.key}
                  root={root}
                  meetsThreshold={root.gameCount >= prepPromptThreshold}
                  selected={root.opening.key === selectedRootKey}
                  onSelect={() => root.lines.length > 0 && setSelectedRootKey(root.opening.key)}
                  onStudyAnyway={() => void applyDraft(root.opening.key)}
                  applying={applying}
                  canApply={!!target && root.lines.length > 0}
                />
              ))}
            </div>
          </>
        )}

        {applyStatus && <div className="account-status good small">{applyStatus}</div>}
      </div>
      {conflict && (
        <ConflictResolveModal
          fen={conflict.fen}
          color={conflict.color}
          existing={conflict.existing}
          candidate={conflict.candidate}
          algorithmPickSan={conflict.algorithmPickSan}
          reason={conflict.reason}
          onChoose={resolveConflict}
        />
      )}
    </div>
  );
}

function OpeningPromptList({ roots, selectedRootKey, onSelect }: {
  roots: RootDraft[];
  selectedRootKey: string | null;
  onSelect: (key: string) => void;
}) {
  if (roots.length === 0) {
    return (
      <div className="import-memory-note">
        No opening reached the study threshold yet. Chesski saved the import, so those openings can still be used later from New Opening.
      </div>
    );
  }

  return (
    <div className="import-prompt-panel">
      <h4>Pick one to study first</h4>
      <div className="import-prompt-list">
        {roots.map(root => (
          <button
            key={root.opening.key}
            className={root.opening.key === selectedRootKey ? 'selected-choice' : ''}
            onClick={() => onSelect(root.opening.key)}
          >
            <strong>{root.opening.name}</strong>
            <span>{root.gameCount} games</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RootDraftCard({ root, meetsThreshold, selected, onSelect, onStudyAnyway, applying, canApply }: {
  root: RootDraft;
  meetsThreshold: boolean;
  selected: boolean;
  onSelect: () => void;
  onStudyAnyway: () => void;
  applying: boolean;
  canApply: boolean;
}) {
  const preview = previewFen(root.opening.moves);
  const replacements = root.decisions.filter(item => item.kind === 'replaced').length;
  return (
    <div className={'import-root-card' + (selected ? ' selected' : '')}>
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
        <div className="row import-root-actions">
          {meetsThreshold ? (
            <button onClick={onSelect} disabled={root.lines.length === 0}>{selected ? 'Selected' : 'Study this first'}</button>
          ) : (
            <button onClick={onStudyAnyway} disabled={applying || !canApply}>
              {applying ? 'Adding...' : 'Study anyway'}
            </button>
          )}
          {!meetsThreshold && <span className="muted small">Saved for later</span>}
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

function usernamePlaceholder(source: ImportSource): string {
  if (source === 'chesscom') return 'Chess.com username';
  if (source === 'lichess') return 'Lichess username';
  return 'Username in PGN headers';
}
