import { useEffect, useState } from 'react';
import type { Repertoire } from '../types';
import { cloneRepertoire, getEdgesForRepertoire, updateRepertoire } from '../lib/storage';

export function RepertoiresMode({
  repertoires,
  activeRepId,
  onSelect,
  onOpen,
  onCreated,
  onChanged,
  onDelete,
  onNewOpening,
}: {
  repertoires: Repertoire[];
  activeRepId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onCreated: (rep: Repertoire) => void | Promise<void>;
  onChanged: () => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onNewOpening: () => void;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(repertoires.map(async rep => [rep.id, (await getEdgesForRepertoire(rep.id)).length] as const));
      if (!cancelled) setCounts(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [repertoires]);

  function startRename(rep: Repertoire) {
    setEditingId(rep.id);
    setDraftName(rep.name);
  }

  async function saveRename(rep: Repertoire) {
    setError(null);
    try {
      await updateRepertoire(rep.id, { name: draftName });
      setEditingId(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function setKind(rep: Repertoire, projectKind: Repertoire['projectKind']) {
    setError(null);
    try {
      await updateRepertoire(rep.id, { projectKind });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function clone(rep: Repertoire) {
    setError(null);
    try {
      const cloned = await cloneRepertoire(rep.id);
      await onCreated(cloned);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const standard = repertoires.filter(rep => (rep.projectKind ?? 'standard') !== 'siloed');
  const siloed = repertoires.filter(rep => rep.projectKind === 'siloed');

  return (
    <div className="layout rep-manager-layout">
      <div className="panel">
        <h3>Repertoires</h3>
        <div className="muted small settings-copy">
          Openings live inside a repertoire. Side repertoires are for plans that intentionally disagree from the same position.
        </div>
        <ProjectGroup
          title="main repertoire"
          reps={standard}
          activeRepId={activeRepId}
          counts={counts}
          editingId={editingId}
          draftName={draftName}
          setDraftName={setDraftName}
          onSelect={onSelect}
          onOpen={onOpen}
          onRename={startRename}
          onSaveRename={saveRename}
          onSetKind={setKind}
          onClone={clone}
          onDelete={onDelete}
        />
        <ProjectGroup
          title="side repertoires"
          reps={siloed}
          activeRepId={activeRepId}
          counts={counts}
          editingId={editingId}
          draftName={draftName}
          setDraftName={setDraftName}
          onSelect={onSelect}
          onOpen={onOpen}
          onRename={startRename}
          onSaveRename={saveRename}
          onSetKind={setKind}
          onClone={clone}
          onDelete={onDelete}
        />
        {error && <div className="small account-status bad">{error}</div>}
      </div>

      <div className="panel rep-opening-cta">
        <h3>Add opening</h3>
        <div className="account-note">
          The visual catalog handles both new repertoires and adding another branch into an existing repertoire.
        </div>
        <button className="primary rep-opening-cta-button" onClick={onNewOpening}>Open catalog</button>
      </div>
    </div>
  );
}

function ProjectGroup({
  title,
  reps,
  activeRepId,
  counts,
  editingId,
  draftName,
  setDraftName,
  onSelect,
  onOpen,
  onRename,
  onSaveRename,
  onSetKind,
  onClone,
  onDelete,
}: {
  title: string;
  reps: Repertoire[];
  activeRepId: string | null;
  counts: Record<string, number>;
  editingId: string | null;
  draftName: string;
  setDraftName: (value: string) => void;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onRename: (rep: Repertoire) => void;
  onSaveRename: (rep: Repertoire) => void | Promise<void>;
  onSetKind: (rep: Repertoire, kind: Repertoire['projectKind']) => void | Promise<void>;
  onClone: (rep: Repertoire) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}) {
  return (
    <div className="rep-group">
      <h4>{title}</h4>
      {reps.length === 0 ? (
        <div className="settings-empty-drop">Nothing here yet</div>
      ) : reps.map(rep => {
        const editing = editingId === rep.id;
        return (
          <div key={rep.id} className={'rep-card' + (rep.id === activeRepId ? ' active' : '')}>
            <div className="rep-card-main">
              {editing ? (
                <input
                  value={draftName}
                  onChange={e => setDraftName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void onSaveRename(rep); }}
                  autoFocus
                />
              ) : (
                <button className="rep-title-button" onClick={() => onSelect(rep.id)}>{rep.name}</button>
              )}
              <div className="muted small">
                {rep.color === 'w' ? 'White' : 'Black'} · {counts[rep.id] ?? 0} moves · {(rep.projectKind ?? 'standard') === 'siloed' ? 'separate' : 'main'}
              </div>
            </div>
            <div className="rep-card-actions">
              {editing ? (
                <button onClick={() => onSaveRename(rep)}>Save</button>
              ) : (
                <button onClick={() => onRename(rep)}>Rename</button>
              )}
              <button className="primary" onClick={() => onOpen(rep.id)}>Open</button>
              <button onClick={() => onSetKind(rep, (rep.projectKind ?? 'standard') === 'siloed' ? 'standard' : 'siloed')}>
                {(rep.projectKind ?? 'standard') === 'siloed' ? 'Move to main repertoire' : 'Make side repertoire'}
              </button>
              <button onClick={() => onClone(rep)}>Clone</button>
              <button className="danger" onClick={() => onDelete(rep.id)}>Delete</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
