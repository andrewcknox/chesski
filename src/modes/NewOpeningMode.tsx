import { useEffect, useMemo, useState } from 'react';
import { Board } from '../components/Board';
import { applyMove, STARTING_FEN_NORM } from '../lib/chess';
import {
  addOpeningToRepertoire,
  createRepertoire,
  CURATED_OPENINGS,
} from '../lib/storage';
import type { CuratedOpening } from '../lib/openings';
import type { NormFen, Repertoire } from '../types';

type FlowMode = 'new' | 'add';

interface OpeningPreview {
  opening: CuratedOpening;
  signatureFen: NormFen;
  moveText: string;
}

export function NewOpeningMode({
  repertoires,
  activeRepId,
  onCreated,
  onChanged,
  onOpen,
  startOnly = false,
}: {
  repertoires: Repertoire[];
  activeRepId: string | null;
  onCreated: (rep: Repertoire) => void | Promise<void>;
  onChanged: () => void | Promise<void>;
  onOpen: (id: string) => void;
  startOnly?: boolean;
}) {
  const openings = useMemo(() => CURATED_OPENINGS.map(openingPreview), []);
  const [selectedKey, setSelectedKey] = useState(openings[0]?.opening.key ?? '');
  const selected = openings.find(item => item.opening.key === selectedKey) ?? openings[0] ?? null;
  const [mode, setMode] = useState<FlowMode>(startOnly || repertoires.length === 0 ? 'new' : 'add');
  const [targetId, setTargetId] = useState(activeRepId ?? repertoires[0]?.id ?? '');
  const [name, setName] = useState('');
  const [projectKind, setProjectKind] = useState<Repertoire['projectKind']>('standard');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const compatibleTargets = useMemo(() => {
    if (!selected) return repertoires;
    return repertoires.filter(rep => rep.color === selected.opening.color);
  }, [repertoires, selected]);

  useEffect(() => {
    if (startOnly || repertoires.length === 0) setMode('new');
  }, [repertoires.length, startOnly]);

  useEffect(() => {
    if (!selected) return;
    setName(selected.opening.name);
    setStatus(null);
    setError(null);
  }, [selected]);

  useEffect(() => {
    if (mode !== 'add') return;
    if (compatibleTargets.some(rep => rep.id === targetId)) return;
    setTargetId(compatibleTargets[0]?.id ?? '');
  }, [compatibleTargets, mode, targetId]);

  async function createSelected() {
    if (!selected) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const rep = await createRepertoire({
        name: name.trim() || selected.opening.name,
        color: selected.opening.color,
        openingKey: selected.opening.key,
        moves: selected.opening.moves,
        projectKind,
      });
      await onCreated(rep);
      onOpen(rep.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addSelected() {
    if (!selected || !targetId) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const result = await addOpeningToRepertoire(targetId, selected.opening.key);
      await onChanged();
      setStatus(`${selected.opening.name}: ${result.addedEdges} new moves, ${result.reusedEdges} already known.`);
      onOpen(targetId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!selected) {
    return <div className="panel">No curated openings are available yet.</div>;
  }

  return (
    <div className="new-opening-layout">
      <div className="new-opening-main">
        <div className="opening-toolbar">
          <div>
            <h3>New Opening</h3>
            <div className="muted small">Pick a starting point, then create a repertoire or add it to one you already study.</div>
          </div>
          {!startOnly && repertoires.length > 0 && (
            <div className="segmented">
              <button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>New repertoire</button>
              <button className={mode === 'add' ? 'active' : ''} onClick={() => setMode('add')}>Add to existing</button>
            </div>
          )}
        </div>

        <div className="opening-catalog">
          {openings.map(item => (
            <button
              key={item.opening.key}
              className={'opening-card' + (item.opening.key === selected.opening.key ? ' selected' : '')}
              onClick={() => setSelectedKey(item.opening.key)}
            >
              <div className="opening-card-board" aria-hidden="true">
                <Board
                  fen={item.signatureFen}
                  orientation={item.opening.color === 'w' ? 'white' : 'black'}
                  onMove={() => false}
                  allowMoves={false}
                  size={116}
                  showNotation={false}
                />
              </div>
              <div className="opening-card-copy">
                <strong>{item.opening.name}</strong>
                <span>{item.opening.color === 'w' ? 'White' : 'Black'} repertoire</span>
                <span className="opening-card-line">{item.moveText}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="panel opening-action-panel">
        <div className="opening-action-board">
          <Board
            fen={selected.signatureFen}
            orientation={selected.opening.color === 'w' ? 'white' : 'black'}
            onMove={() => false}
            allowMoves={false}
            size={220}
            showNotation={false}
          />
        </div>
        <h3>{selected.opening.name}</h3>
        <div className="opening-line mono">{selected.moveText}</div>
        <div className="muted small opening-action-copy">
          Signature position after {selected.opening.moves.length} moves from the normal starting position.
        </div>

        {mode === 'new' ? (
          <div className="opening-action-form">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Repertoire name" />
            <label className="row new-rep-check">
              <input
                type="checkbox"
                checked={projectKind === 'siloed'}
                onChange={e => setProjectKind(e.target.checked ? 'siloed' : 'standard')}
              />
              <span>
                Side repertoire
                <span className="muted small"> can contradict your main repertoire</span>
              </span>
            </label>
            <button className="primary" onClick={createSelected} disabled={busy}>
              {busy ? 'Creating...' : 'Create and learn'}
            </button>
          </div>
        ) : (
          <div className="opening-action-form">
            {compatibleTargets.length > 0 ? (
              <>
                <select value={targetId} onChange={e => setTargetId(e.target.value)}>
                  {compatibleTargets.map(rep => (
                    <option key={rep.id} value={rep.id}>{rep.name} ({rep.color === 'w' ? 'White' : 'Black'})</option>
                  ))}
                </select>
                <button className="primary" onClick={addSelected} disabled={busy || !targetId}>
                  {busy ? 'Adding...' : 'Add and learn'}
                </button>
              </>
            ) : (
              <>
                <div className="settings-empty-drop">No {selected.opening.color === 'w' ? 'White' : 'Black'} repertoire yet</div>
                <button onClick={() => setMode('new')}>Create one instead</button>
              </>
            )}
          </div>
        )}

        {status && <div className="small account-status good">{status}</div>}
        {error && <div className="small account-status bad">{error}</div>}
      </div>
    </div>
  );
}

function openingPreview(opening: CuratedOpening): OpeningPreview {
  let fen = STARTING_FEN_NORM;
  for (const move of opening.moves) {
    const result = applyMove(fen, move);
    if (!result) break;
    fen = result.fen;
  }
  return {
    opening,
    signatureFen: fen,
    moveText: opening.moves.join(' '),
  };
}
