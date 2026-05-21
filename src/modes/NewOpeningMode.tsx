import { useEffect, useMemo, useState } from 'react';
import { Board } from '../components/Board';
import { applyMove, STARTING_FEN_NORM, turnAt } from '../lib/chess';
import {
  addMovesToRepertoire,
  createRepertoire,
  CURATED_OPENINGS,
  getEdgesForRepertoire,
  getRepertoire,
  markCuratedOpeningScaffolds,
} from '../lib/storage';
import {
  getImportMemoryForOpening,
  importMemoryKeyForOpening,
  type ImportMemoryEntry,
} from '../lib/importMemory';
import { findOpeningPathInRepertoire } from '../lib/openingFolders';
import { prepareOpeningLineForRepertoire } from '../lib/openingRoots';
import type { CuratedOpening, OpeningLine } from '../lib/openings';
import type { Color, NormFen, Repertoire } from '../types';

type FlowMode = 'new' | 'add';

interface OpeningPreview {
  signatureFen: NormFen;
  moveText: string;
}

interface CatalogPreview extends OpeningPreview {
  opening: CuratedOpening;
}

interface MoveTreeNode {
  move: string | null;
  moves: string[];
  lineNames: string[];
  children: MoveTreeNode[];
}

interface PrepFlow {
  action: FlowMode;
  root: CuratedOpening;
  tree: MoveTreeNode;
  path: MoveTreeNode[];
  selectedMoves: string[][];
  completedPaths: string[];
}

const CUSTOM_OPENING_KEY = '__custom__';

export function NewOpeningMode({
  repertoires,
  activeRepId,
  onCreated,
  onChanged,
  onOpen,
  startOnly = false,
  scopedRepertoireId = null,
  onBack,
  onStartPrepMap,
}: {
  repertoires: Repertoire[];
  activeRepId: string | null;
  onCreated: (rep: Repertoire) => void | Promise<void>;
  onChanged: () => void | Promise<void>;
  onOpen: (id: string, openingKey?: string | null) => void;
  startOnly?: boolean;
  scopedRepertoireId?: string | null;
  onBack?: () => void;
  onStartPrepMap?: (repId: string, openingKey: string) => void;
}) {
  const scopedRepertoire = scopedRepertoireId ? repertoires.find(rep => rep.id === scopedRepertoireId) ?? null : null;
  const scopedAdd = !!scopedRepertoire;
  const openings = useMemo<CatalogPreview[]>(() => CURATED_OPENINGS.map(opening => ({
    opening,
    ...openingPreview(opening),
  })), []);
  const [catalogColor, setCatalogColor] = useState<Color>(() => {
    const active = scopedRepertoire ?? repertoires.find(rep => rep.id === activeRepId);
    return active?.color ?? 'w';
  });
  const visibleOpenings = useMemo(() => openings.filter(item => item.opening.color === catalogColor), [catalogColor, openings]);
  const [selectedKey, setSelectedKey] = useState(visibleOpenings[0]?.opening.key ?? '');
  const [historyByKey, setHistoryByKey] = useState<Record<string, ImportMemoryEntry | null>>({});
  const [mode, setMode] = useState<FlowMode>(scopedAdd ? 'add' : startOnly || repertoires.length === 0 ? 'new' : 'add');
  const [targetId, setTargetId] = useState(scopedRepertoireId ?? activeRepId ?? repertoires[0]?.id ?? '');
  const [name, setName] = useState('');
  const [customName, setCustomName] = useState('Build Your Own');
  const [customColor, setCustomColor] = useState<Color>('w');
  const [customMoves, setCustomMoves] = useState('');
  const [projectKind, setProjectKind] = useState<Repertoire['projectKind']>(startOnly ? 'standard' : 'siloed');
  const [prepFlow, setPrepFlow] = useState<PrepFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addedOpeningKeys, setAddedOpeningKeys] = useState<Record<string, true>>({});

  const compatibleTargets = useMemo(() => {
    if (scopedRepertoire) return [scopedRepertoire];
    const targetColor = selectedKey === CUSTOM_OPENING_KEY ? customColor : catalogColor;
    return repertoires.filter(rep => rep.color === targetColor);
  }, [catalogColor, customColor, repertoires, scopedRepertoire, selectedKey]);
  const displayedOpenings = useMemo(() => {
    if (mode !== 'add' || !targetId) return visibleOpenings;
    return visibleOpenings.filter(item => !addedOpeningKeys[item.opening.key]);
  }, [addedOpeningKeys, mode, targetId, visibleOpenings]);
  const selected = selectedKey === CUSTOM_OPENING_KEY
    ? null
    : displayedOpenings.find(item => item.opening.key === selectedKey) ?? displayedOpenings[0] ?? null;
  const selectedHistory = selected ? historyByKey[importMemoryKeyForOpening(selected.opening)] ?? null : null;

  useEffect(() => {
    if (scopedRepertoire) {
      setCatalogColor(scopedRepertoire.color);
      setMode('add');
      setTargetId(scopedRepertoire.id);
      if (selectedKey !== CUSTOM_OPENING_KEY && !displayedOpenings.some(item => item.opening.key === selectedKey)) {
        setSelectedKey(displayedOpenings[0]?.opening.key ?? '');
      }
      return;
    }
    setCustomColor(catalogColor);
    if (selectedKey === CUSTOM_OPENING_KEY) return;
    if (displayedOpenings.some(item => item.opening.key === selectedKey)) return;
    setSelectedKey(displayedOpenings[0]?.opening.key ?? CUSTOM_OPENING_KEY);
  }, [catalogColor, displayedOpenings, scopedRepertoire, selectedKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(displayedOpenings.map(async item => {
        const key = importMemoryKeyForOpening(item.opening);
        const memory = await getImportMemoryForOpening(item.opening);
        return [key, memory] as const;
      }));
      if (!cancelled) {
        setHistoryByKey(current => ({ ...current, ...Object.fromEntries(entries) }));
      }
    })();
    return () => { cancelled = true; };
  }, [displayedOpenings]);

  useEffect(() => {
    if (mode !== 'add' || !targetId) {
      setAddedOpeningKeys({});
      return;
    }
    let cancelled = false;
    (async () => {
      const rep = await getRepertoire(targetId);
      if (!rep) {
        if (!cancelled) setAddedOpeningKeys({});
        return;
      }
      const edges = await getEdgesForRepertoire(rep.id);
      const next: Record<string, true> = {};
      for (const item of openings.filter(opening => opening.opening.color === rep.color)) {
        if (findOpeningPathInRepertoire(rep, item.opening, edges)) next[item.opening.key] = true;
      }
      if (!cancelled) setAddedOpeningKeys(next);
    })().catch(err => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [mode, openings, targetId]);

  useEffect(() => {
    if (startOnly || repertoires.length === 0) setMode('new');
  }, [repertoires.length, startOnly]);

  useEffect(() => {
    if (selectedKey === CUSTOM_OPENING_KEY) {
      setName(customName);
      setPrepFlow(null);
      setStatus(null);
      setError(null);
      return;
    }
    if (!selected) return;
    setName(selected.opening.name);
    setPrepFlow(null);
    setStatus(null);
    setError(null);
  }, [customName, selected, selectedKey]);

  useEffect(() => {
    if (mode !== 'add') return;
    if (compatibleTargets.some(rep => rep.id === targetId)) return;
    setTargetId(compatibleTargets[0]?.id ?? '');
  }, [compatibleTargets, mode, targetId]);

  function startPreparation(action: FlowMode) {
    if (!selected) return;
    setStatus(null);
    setError(null);
    const tree = buildMoveTree(selected.opening);
    if (tree.children.length === 0) {
      void executePrepared(action, []);
      return;
    }
    setPrepFlow({
      action,
      root: selected.opening,
      tree,
      path: [tree],
      selectedMoves: [],
      completedPaths: [],
    });
  }

  async function executePrepared(action: FlowMode, selectedMoves: string[][]) {
    if (!selected) return;
    const lines = selectedMoves.length > 0 ? selectedMoves : [selected.opening.moves];
    if (action === 'new') await createSelected(lines);
    else await addSelected(lines);
  }

  async function applyImportedHistory(action: FlowMode) {
    if (!selectedHistory) return;
    if (action === 'new') await createSelected(selectedHistory.lines);
    else await addSelected(selectedHistory.lines);
  }

  async function createSelected(lines: string[][]) {
    if (!selected) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const rep = await createRepertoire({
        name: name.trim() || selected.opening.name,
        color: selected.opening.color,
        openingKey: selected.opening.key,
        projectKind,
      });
      for (const line of lines) {
        const prepared = prepareOpeningLineForRepertoire(rep, selected.opening, line);
        if (prepared.moves.length === 0) continue;
        await addMovesToRepertoire(rep, prepared.moves, { scaffoldPlyCount: prepared.scaffoldPlyCount });
      }
      await markCuratedOpeningScaffolds(rep);
      setPrepFlow(null);
      await onCreated(rep);
      onOpen(rep.id, selected.opening.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addSelected(lines: string[][]) {
    if (!selected || !targetId) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      let addedEdges = 0;
      let reusedEdges = 0;
      const rep = await getRepertoire(targetId);
      if (!rep) throw new Error('Could not find that repertoire.');
      for (const line of lines) {
        const prepared = prepareOpeningLineForRepertoire(rep, selected.opening, line);
        if (prepared.moves.length === 0) continue;
        const result = await addMovesToRepertoire(rep, prepared.moves, { scaffoldPlyCount: prepared.scaffoldPlyCount });
        addedEdges += result.addedEdges;
        reusedEdges += result.reusedEdges;
      }
      await markCuratedOpeningScaffolds(rep);
      setPrepFlow(null);
      await onChanged();
      setAddedOpeningKeys(current => ({ ...current, [selected.opening.key]: true }));
      setStatus(`${selected.opening.name}: ${addedEdges} new moves, ${reusedEdges} already known.`);
      onOpen(targetId, selected.opening.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addSelectedBaseAndStartPrepMap() {
    if (!selected || !targetId) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const rep = await getRepertoire(targetId);
      if (!rep) throw new Error('Could not find that repertoire.');
      const prepared = prepareOpeningLineForRepertoire(rep, selected.opening, selected.opening.moves);
      if (prepared.moves.length > 0) {
        await addMovesToRepertoire(rep, prepared.moves, { scaffoldPlyCount: prepared.scaffoldPlyCount });
      }
      await markCuratedOpeningScaffolds(rep);
      await onChanged();
      setAddedOpeningKeys(current => ({ ...current, [selected.opening.key]: true }));
      setPrepFlow(null);
      onStartPrepMap?.(targetId, selected.opening.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function createCustom() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const moves = parseMoveText(customMoves);
      const rep = await createRepertoire({
        name: customName.trim() || 'Build Your Own',
        color: customColor,
        openingKey: null,
        moves,
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

  async function addCustom() {
    if (!targetId) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const moves = parseMoveText(customMoves);
      const rep = await getRepertoire(targetId);
      if (!rep) throw new Error('Could not find that repertoire.');
      const result = await addMovesToRepertoire(rep, moves);
      await onChanged();
      setStatus(`${customName.trim() || 'Custom line'}: ${result.addedEdges} new moves, ${result.reusedEdges} already known.`);
      onOpen(targetId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function goDeeper(node: MoveTreeNode) {
    if (!prepFlow || prepFlow.completedPaths.includes(pathKey(node.moves)) || node.children.length === 0) return;
    setPrepFlow({
      ...prepFlow,
      path: [...prepFlow.path, node],
    });
  }

  function startFromHere(node: MoveTreeNode) {
    if (!prepFlow) return;
    setPrepFlow(completeAndCollapse(prepFlow, node.moves, node.moves));
  }

  function choosePlayerMove(node: MoveTreeNode) {
    if (!prepFlow || prepFlow.completedPaths.includes(pathKey(node.moves))) return;
    if (node.children.length > 0) {
      setPrepFlow({ ...prepFlow, path: [...prepFlow.path, node] });
      return;
    }
    setPrepFlow(completeAndCollapse(prepFlow, node.moves, node.moves));
  }

  function finishPreparation() {
    if (!prepFlow) return;
    void executePrepared(prepFlow.action, prepFlow.selectedMoves);
  }

  if (!selected && selectedKey !== CUSTOM_OPENING_KEY && displayedOpenings.length > 0) {
    return <div className="panel">No curated openings are available yet.</div>;
  }

  return (
    <div className="new-opening-layout focused-subview">
      {prepFlow && (
        <ContinuationModal
          flow={prepFlow}
          color={prepFlow.root.color}
          busy={busy}
          onGoDeeper={goDeeper}
          onStartHere={startFromHere}
          onChoosePlayerMove={choosePlayerMove}
          onBack={() => setPrepFlow(flow => flow && flow.path.length > 1 ? { ...flow, path: flow.path.slice(0, -1) } : flow)}
          onCancel={() => setPrepFlow(null)}
          onFinish={finishPreparation}
        />
      )}

      <div className="new-opening-main">
        {onBack && (
          <div className="subview-back-row add-opening-back-row">
            <button onClick={onBack}>Back</button>
          </div>
        )}
        <div className="opening-toolbar">
          <div>
            <div className="eyebrow">{scopedAdd ? 'Add opening' : 'New opening'}</div>
            <h2>{scopedRepertoire ? scopedRepertoire.name : 'Opening catalog'}</h2>
            <div className="muted small">
              {scopedRepertoire
                ? 'Choose the next opening folder for this repertoire.'
                : 'Pick the side you are preparing, then choose a starting point.'}
            </div>
          </div>
          <div className="opening-toolbar-controls">
            {!scopedAdd && <div className="segmented">
              <button className={catalogColor === 'w' ? 'active' : ''} onClick={() => setCatalogColor('w')}>White openings</button>
              <button className={catalogColor === 'b' ? 'active' : ''} onClick={() => setCatalogColor('b')}>Black openings</button>
            </div>}
            {!scopedAdd && !startOnly && repertoires.length > 0 && (
              <div className="segmented">
                <button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>New repertoire</button>
                <button className={mode === 'add' ? 'active' : ''} onClick={() => setMode('add')}>Add to repertoire</button>
              </div>
            )}
          </div>
        </div>

        <div className="opening-catalog">
          {displayedOpenings.map(item => {
            const history = historyByKey[importMemoryKeyForOpening(item.opening)];
            return (
              <button
                key={item.opening.key}
                className={'opening-card' + (item.opening.key === selectedKey ? ' selected' : '')}
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
                  <span>{item.opening.color === 'w' ? 'White' : 'Black'} opening</span>
                  {history && <span className="opening-history-pill">{history.gameCount} imported games</span>}
                  <span className="opening-card-line">{item.moveText}</span>
                </div>
              </button>
            );
          })}
          {!scopedAdd && <button
            className={'opening-card custom-opening-card' + (selectedKey === CUSTOM_OPENING_KEY ? ' selected' : '')}
            onClick={() => setSelectedKey(CUSTOM_OPENING_KEY)}
          >
            <div className="custom-opening-mark" aria-hidden="true">+</div>
            <div className="opening-card-copy">
              <strong>Build Your Own</strong>
              <span>Manual line builder</span>
              <span className="opening-card-line">Paste or type your own moves</span>
            </div>
          </button>}
          {displayedOpenings.length === 0 && (
            <div className="settings-empty-drop add-opening-empty empty-state">
              Every {catalogColor === 'w' ? 'White' : 'Black'} opening in the catalog has already been added to this repertoire.
            </div>
          )}
        </div>
      </div>

      <div className="panel opening-action-panel">
        {selectedKey === CUSTOM_OPENING_KEY ? (
          <CustomOpeningPanel
            mode={mode}
            customName={customName}
            customColor={customColor}
            customMoves={customMoves}
            compatibleTargets={compatibleTargets}
            targetId={targetId}
            projectKind={projectKind}
            busy={busy}
            onNameChange={setCustomName}
            onColorChange={setCustomColor}
            onMovesChange={setCustomMoves}
            onTargetChange={setTargetId}
            onProjectKindChange={setProjectKind}
            onCreate={createCustom}
            onAdd={addCustom}
            onCreateInstead={() => setMode('new')}
          />
        ) : selected && (
          <>
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

            {selectedHistory && (
              <div className="opening-history-panel">
                <strong>Use your imported history?</strong>
                <div className="muted small">
                  Chesski found {selectedHistory.gameCount} of your games in this opening and saved {selectedHistory.lines.length} line{selectedHistory.lines.length === 1 ? '' : 's'} from that import.
                </div>
                <div className="row opening-history-actions">
                  <button className="primary" onClick={() => void applyImportedHistory(mode)} disabled={busy || (mode === 'add' && !targetId)}>
                    {busy ? 'Adding...' : 'Use my history'}
                  </button>
                  <span className="muted small">Or continue below with Chesski's normal algorithm.</span>
                </div>
              </div>
            )}

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
                Separate repertoire
                <span className="muted small"> can contradict another repertoire</span>
              </span>
            </label>
            <button className="primary" onClick={() => startPreparation('new')} disabled={busy}>
              {busy ? 'Creating...' : "Use Chesski's algorithm"}
            </button>
          </div>
            ) : (
          <div className="opening-action-form">
            {compatibleTargets.length > 0 ? (
              <>
                {!scopedAdd && (
                  <>
                    <label className="small muted" htmlFor="opening-target-repertoire">Add to repertoire</label>
                    <select id="opening-target-repertoire" value={targetId} onChange={e => setTargetId(e.target.value)}>
                      {compatibleTargets.map(rep => (
                        <option key={rep.id} value={rep.id}>{rep.name} ({rep.color === 'w' ? 'White' : 'Black'})</option>
                      ))}
                    </select>
                  </>
                )}
                <button className="primary" onClick={() => scopedAdd ? void addSelectedBaseAndStartPrepMap() : startPreparation('add')} disabled={busy || !targetId}>
                  {busy ? 'Adding...' : "Use Chesski's algorithm"}
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
          </>
        )}

        {status && <div className="small account-status good">{status}</div>}
        {error && <div className="small account-status bad">{error}</div>}
      </div>
    </div>
  );
}

function CustomOpeningPanel({
  mode,
  customName,
  customColor,
  customMoves,
  compatibleTargets,
  targetId,
  projectKind,
  busy,
  onNameChange,
  onColorChange,
  onMovesChange,
  onTargetChange,
  onProjectKindChange,
  onCreate,
  onAdd,
  onCreateInstead,
}: {
  mode: FlowMode;
  customName: string;
  customColor: Color;
  customMoves: string;
  compatibleTargets: Repertoire[];
  targetId: string;
  projectKind: Repertoire['projectKind'];
  busy: boolean;
  onNameChange: (value: string) => void;
  onColorChange: (value: Color) => void;
  onMovesChange: (value: string) => void;
  onTargetChange: (value: string) => void;
  onProjectKindChange: (value: Repertoire['projectKind']) => void;
  onCreate: () => void;
  onAdd: () => void;
  onCreateInstead: () => void;
}) {
  return (
    <>
      <h3>Build Your Own</h3>
      <div className="muted small opening-action-copy">
        Type a SAN move list from the starting position. Move numbers are fine.
      </div>
      <div className="opening-action-form">
        <input value={customName} onChange={e => onNameChange(e.target.value)} placeholder="Line name" />
        <textarea
          className="custom-opening-moves"
          value={customMoves}
          onChange={e => onMovesChange(e.target.value)}
          placeholder="1. e4 e5 2. Nf3 Nc6 3. Bc4"
        />
        <div className="row">
          <label className="small muted">Color</label>
          <select value={customColor} onChange={e => onColorChange(e.target.value as Color)}>
            <option value="w">White</option>
            <option value="b">Black</option>
          </select>
        </div>
        {mode === 'new' ? (
          <>
            <label className="row new-rep-check">
              <input
                type="checkbox"
                checked={projectKind === 'siloed'}
                onChange={e => onProjectKindChange(e.target.checked ? 'siloed' : 'standard')}
              />
              <span>
                Separate repertoire
                <span className="muted small"> can contradict another repertoire</span>
              </span>
            </label>
            <button className="primary" onClick={onCreate} disabled={busy || !customMoves.trim()}>
              {busy ? 'Creating...' : 'Create custom line'}
            </button>
          </>
        ) : compatibleTargets.length > 0 ? (
          <>
            <label className="small muted" htmlFor="custom-opening-target-repertoire">Add to repertoire</label>
            <select id="custom-opening-target-repertoire" value={targetId} onChange={e => onTargetChange(e.target.value)}>
              {compatibleTargets.map(rep => (
                <option key={rep.id} value={rep.id}>{rep.name} ({rep.color === 'w' ? 'White' : 'Black'})</option>
              ))}
            </select>
            <button className="primary" onClick={onAdd} disabled={busy || !targetId || !customMoves.trim()}>
              {busy ? 'Adding...' : 'Add custom line'}
            </button>
          </>
        ) : (
          <>
            <div className="settings-empty-drop">No {customColor === 'w' ? 'White' : 'Black'} repertoire yet</div>
            <button onClick={onCreateInstead}>Create one instead</button>
          </>
        )}
      </div>
    </>
  );
}

function ContinuationModal({
  flow,
  color,
  busy,
  onGoDeeper,
  onStartHere,
  onChoosePlayerMove,
  onBack,
  onCancel,
  onFinish,
}: {
  flow: PrepFlow;
  color: 'w' | 'b';
  busy: boolean;
  onGoDeeper: (node: MoveTreeNode) => void;
  onStartHere: (node: MoveTreeNode) => void;
  onChoosePlayerMove: (node: MoveTreeNode) => void;
  onBack: () => void;
  onCancel: () => void;
  onFinish: () => void;
}) {
  const current = flow.path[flow.path.length - 1];
  const atRoot = flow.path.length === 1;
  const options = current.children;
  const selectedCount = flow.selectedMoves.length;
  const currentPreview = movesPreview(current.moves);
  const title = current.lineNames[0] ?? flow.root.name;
  const turn = turnAt(currentPreview.signatureFen);
  const playerToMove = turn === color;
  const prompt = playerToMove
    ? 'Which move do you prefer?'
    : 'Do you have prepared responses you want to keep?';

  return (
    <div className="modal-backdrop soft">
      <div className="modal continuation-modal">
        <div className="continuation-head">
          <div>
            <h2>{title}</h2>
            <p className="muted">{prompt}</p>
          </div>
          <div className="continuation-board">
            <Board
              fen={currentPreview.signatureFen}
              orientation={color === 'w' ? 'white' : 'black'}
              onMove={() => false}
              allowMoves={false}
              size={128}
              showNotation={false}
            />
          </div>
        </div>

        <div className="continuation-line mono">{currentPreview.moveText}</div>

        <div className="continuation-options">
          {options.map(option => {
            const preview = movesPreview(option.moves);
            const done = flow.completedPaths.includes(pathKey(option.moves));
            const optionTitle = optionLabel(option);
            const optionMove = option.move ?? '';
            return (
              <div
                key={pathKey(option.moves)}
                className={'continuation-option' + (done ? ' done' : '')}
              >
                <div className="continuation-option-board" aria-hidden="true">
                  <Board
                    fen={preview.signatureFen}
                    orientation={color === 'w' ? 'white' : 'black'}
                    onMove={() => false}
                    allowMoves={false}
                    size={86}
                    showNotation={false}
                  />
                </div>
                <div className="continuation-option-copy">
                  <strong>{optionTitle}</strong>
                  {optionTitle !== optionMove && <span>{optionMove}</span>}
                  {optionTitle === optionMove && option.lineNames.length > 0 && <span>{option.lineNames.join(' / ')}</span>}
                  <span className="mono">{preview.moveText}</span>
                  {done && <span className="muted small">prepared</span>}
                  {!done && (
                    <div className="continuation-option-actions">
                      {playerToMove ? (
                        <button className="primary" onClick={() => onChoosePlayerMove(option)} disabled={busy}>
                          Choose
                        </button>
                      ) : (
                        <>
                          <button onClick={() => onGoDeeper(option)} disabled={busy || option.children.length === 0}>
                            Go deeper
                          </button>
                          <button className="primary" onClick={() => onStartHere(option)} disabled={busy}>
                            Prep ends here
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="continuation-actions">
          {!atRoot && (
            <>
              <button onClick={onBack} disabled={busy}>Back</button>
            </>
          )}
          <span className="spacer" />
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="primary" onClick={onFinish} disabled={busy}>
            {selectedCount > 0 ? "That's all. Let's start preparing." : `Nope. Let's start with the ${flow.root.name}.`}
          </button>
        </div>
      </div>
    </div>
  );
}

function buildMoveTree(opening: CuratedOpening): MoveTreeNode {
  const root: MoveTreeNode = {
    move: null,
    moves: opening.moves,
    lineNames: [opening.name],
    children: [],
  };
  for (const line of flattenLines(opening).filter(line => line.moves.length > opening.moves.length)) {
    let cursor = root;
    for (let idx = opening.moves.length; idx < line.moves.length; idx++) {
      const moves = line.moves.slice(0, idx + 1);
      const move = line.moves[idx];
      let child = cursor.children.find(item => item.move === move);
      if (!child) {
        child = { move, moves, lineNames: [], children: [] };
        cursor.children.push(child);
      }
      if (idx === line.moves.length - 1) child.lineNames = unique([...child.lineNames, line.name]);
      cursor = child;
    }
  }
  return root;
}

function flattenLines(line: OpeningLine): OpeningLine[] {
  return [line, ...(line.continuations ?? []).flatMap(flattenLines)];
}

function openingPreview(opening: OpeningLine): OpeningPreview {
  return movesPreview(opening.moves);
}

function movesPreview(moves: string[]): OpeningPreview {
  let fen = STARTING_FEN_NORM;
  for (const move of moves) {
    const result = applyMove(fen, move);
    if (!result) break;
    fen = result.fen;
  }
  return {
    signatureFen: fen,
    moveText: moves.join(' '),
  };
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function uniqueByPath(lines: string[][]): string[][] {
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const line of lines) {
    const key = pathKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }
  return result;
}

function completeAndCollapse(flow: PrepFlow, completedMoves: string[], selectedMoves: string[]): PrepFlow {
  let completedPaths = unique([...flow.completedPaths, pathKey(completedMoves)]);
  const preparedMoves = uniqueByPath([...flow.selectedMoves, selectedMoves]);
  let path = flow.path;

  while (path.length > 1) {
    const current = path[path.length - 1];
    const currentTurn = turnAt(movesPreview(current.moves).signatureFen);
    const playerToMove = currentTurn === flow.root.color;
    const currentDone = playerToMove
      ? current.children.some(child => completedPaths.includes(pathKey(child.moves)))
      : current.children.length > 0 && current.children.every(child => completedPaths.includes(pathKey(child.moves)));

    if (!currentDone) break;
    completedPaths = unique([...completedPaths, pathKey(current.moves)]);
    path = path.slice(0, -1);
  }

  return {
    ...flow,
    path,
    selectedMoves: preparedMoves,
    completedPaths,
  };
}

function optionLabel(node: MoveTreeNode): string {
  return node.lineNames[0] ?? node.move ?? 'Start';
}

function pathKey(moves: string[]): string {
  return moves.join('\u0001');
}

function parseMoveText(value: string): string[] {
  return value
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => !/^\d+\.(\.\.)?$/.test(token))
    .filter(token => !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token))
    .map(token => token.replace(/^\d+\.\.\./, '').replace(/^\d+\./, ''))
    .filter(Boolean);
}
