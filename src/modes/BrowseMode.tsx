import { useEffect, useMemo, useState, useCallback } from 'react';
import { Board } from '../components/Board';
import { BoardThumbnail } from '../components/BoardThumbnail';
import { TreeView } from '../components/TreeView';
import { deleteOpeningFolderInRepertoire, deleteSubtreeInRepertoire, getEdgesForRepertoire, getAllNodes, putEdge, resetAllSrsForRepertoire } from '../lib/storage';
import { freshSrsState } from '../lib/srs';
import { pvCpForColor } from '../lib/autosuggest';
import { fetchCloudEval } from '../lib/lichess';
import { listOpeningFoldersForRepertoire, type OpeningFolder } from '../lib/openingFolders';
import { buildPreparedLineItems } from '../lib/viewLines';
import type { Edge, NormFen, PositionNode, Repertoire } from '../types';
import ecoDataRaw from '../data/eco.json';

const ECO_DATA = ecoDataRaw as Record<string, { eco: string; name: string }>;

function lookupOpening(fen: NormFen): { eco: string; name: string } | null {
  return ECO_DATA[fen] ?? null;
}

// One leaf-line in the user's repertoire tree.
interface LineItem {
  leafFen: NormFen;
  // path of edges from root to leaf
  path: Edge[];
  // deepest ECO-named position along the path (or root if none); null fen means root has no name
  categoryFen: NormFen | null;
  categoryName: string | null;
  categoryEco: string | null;
  // SAN moves AFTER the categoryFen, used to label this specific leaf-line
  extensionSan: string;
  // SAN of the entire line (root → leaf), for tooltips/details
  fullSan: string;
}

function buildLines(rootFen: NormFen, edges: Edge[], color: Repertoire['color']): LineItem[] {
  return buildPreparedLineItems(rootFen, edges, color, lookupOpening) as LineItem[];
}

function lastMoveHighlights(edge: Edge): Record<string, string> {
  return {
    [edge.uci.slice(0, 2)]: 'rgba(245, 211, 90, 0.18)',
    [edge.uci.slice(2, 4)]: 'rgba(245, 211, 90, 0.28)',
  };
}

interface OpeningGroup {
  fen: NormFen | null; // null for "Unknown"
  eco: string | null;
  name: string;
  lines: LineItem[];
  subfolders: VariationFolder[];
}

interface VariationFolder {
  fen: NormFen;
  label: string; // the move(s) that led to this position
  lines: LineItem[];
  subfolders: VariationFolder[];
}

function groupLines(lines: LineItem[], edges: Edge[]): OpeningGroup[] {
  const map = new Map<string, OpeningGroup>();

  // Build map of positions to their outgoing edges (for counting children)
  const childCountByFen = new Map<NormFen, number>();
  for (const e of edges) {
    childCountByFen.set(e.parentFen, (childCountByFen.get(e.parentFen) ?? 0) + 1);
  }

  for (const l of lines) {
    const key = l.categoryFen ?? '__none__';
    let g = map.get(key);
    if (!g) {
      g = {
        fen: l.categoryFen,
        eco: l.categoryEco,
        name: l.categoryName ?? 'Unnamed positions',
        lines: [],
        subfolders: [],
      };
      map.set(key, g);
    }

    // Find branching point for this line
    let branchingFen: NormFen | null = null;
    let branchingLabel = '';
    for (let i = 0; i < l.path.length; i++) {
      const childCount = childCountByFen.get(l.path[i].childFen) ?? 0;
      if (childCount >= 6) {
        branchingFen = l.path[i].childFen;
        branchingLabel = l.path[i].san;
        break;
      }
    }

    if (branchingFen) {
      // Find or create subfolder for this branching point
      let subfolder = g.subfolders.find(sf => sf.fen === branchingFen);
      if (!subfolder) {
        subfolder = {
          fen: branchingFen,
          label: branchingLabel,
          lines: [],
          subfolders: [],
        };
        g.subfolders.push(subfolder);
      }
      subfolder.lines.push(l);
    } else {
      // No branching point - goes to "other positions"
      g.lines.push(l);
    }
  }

  // Sort subfolders and groups
  for (const g of map.values()) {
    g.subfolders.sort((a, b) => a.label.localeCompare(b.label));
  }

  const arr = Array.from(map.values());
  arr.sort((a, b) => {
    if (a.eco && b.eco) return a.eco.localeCompare(b.eco);
    if (a.eco) return -1;
    if (b.eco) return 1;
    return a.name.localeCompare(b.name);
  });
  return arr;
}


export interface BrowseModeProps {
  repertoire: Repertoire;
  openingKey: string | null;
  onOpeningChange: (openingKey: string | null) => void;
  onDataChange: () => void;
  refreshKey: number;
  boardSize: number;
  onBoardSizeChange: (size: number) => void;
  onBack?: () => void;
}

export function BrowseMode({ repertoire, openingKey, onOpeningChange, onDataChange, refreshKey, boardSize, onBoardSizeChange, onBack }: BrowseModeProps) {
  const [nodes, setNodes] = useState<Map<NormFen, PositionNode>>(new Map());
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedLine, setSelectedLine] = useState<LineItem | null>(null);
  const [selectedPly, setSelectedPly] = useState<number | null>(null);
  const [selectedFen, setSelectedFen] = useState<NormFen>(repertoire.rootFen);

  const reload = useCallback(async () => {
    const [ns, es] = await Promise.all([getAllNodes(), getEdgesForRepertoire(repertoire.id)]);
    setNodes(new Map(ns.map(n => [n.fen, n])));
    setEdges(es);
  }, [repertoire.id]);
  useEffect(() => { void reload(); }, [reload, refreshKey]);
  useEffect(() => {
    setSelectedLine(null);
    setSelectedPly(null);
    setSelectedFen(repertoire.rootFen);
  }, [repertoire.id, repertoire.rootFen]);

  const openingFolders = useMemo(() => listOpeningFoldersForRepertoire(repertoire, edges), [edges, repertoire]);
  const selectedFolder = useMemo(() => {
    if (openingKey) return openingFolders.find(folder => folder.key === openingKey) ?? null;
    return null;
  }, [openingFolders, openingKey]);

  useEffect(() => {
    if (openingKey && !selectedFolder) onOpeningChange(null);
  }, [onOpeningChange, openingKey, selectedFolder]);

  useEffect(() => {
    setSelectedLine(null);
    setSelectedPly(null);
    setSelectedFen(selectedFolder?.baseFen ?? repertoire.rootFen);
  }, [repertoire.id, repertoire.rootFen, selectedFolder?.key, selectedFolder?.baseFen]);

  const lines = useMemo(() => buildLines(repertoire.rootFen, edges, repertoire.color), [repertoire.rootFen, repertoire.color, edges]);
  const visibleLines = useMemo(() => selectedFolder ? lines.filter(line => lineBelongsToFolder(line, selectedFolder)) : lines, [lines, selectedFolder]);
  const visibleEdges = useMemo(() => selectedFolder ? subtreeEdges(selectedFolder.baseFen, edges) : edges, [edges, selectedFolder]);
  const groups = useMemo(() => groupLines(visibleLines, visibleEdges), [visibleLines, visibleEdges]);

  // The displayed FEN: line's leaf if a line is selected; otherwise the manually-selected fen.
  const displayedFen = selectedLine
    ? selectedPly === 0
      ? repertoire.rootFen
      : selectedLine.path[Math.max(0, (selectedPly ?? selectedLine.path.length) - 1)]?.childFen ?? selectedLine.leafFen
    : selectedFen;
  const selectedLineLastMove = selectedLine && selectedPly && selectedPly > 0
    ? selectedLine.path[selectedPly - 1] ?? null
    : null;

  function selectLine(line: LineItem) {
    setSelectedLine(line);
    setSelectedPly(line.path.length);
    setSelectedFen(line.leafFen);
  }

  function selectFen(fen: NormFen) {
    setSelectedLine(null);
    setSelectedPly(null);
    setSelectedFen(fen);
  }

  async function handleDeleteSubtree() {
    const protectedRoot = selectedFolder?.baseFen ?? repertoire.rootFen;
    if (displayedFen === repertoire.rootFen || displayedFen === protectedRoot) {
      alert("Can't delete this root position from here.");
      return;
    }
    const ok = window.confirm('Delete this position and all branches below it (in this repertoire)? This cannot be undone.');
    if (!ok) return;
    await deleteSubtreeInRepertoire(repertoire.id, displayedFen);
    setSelectedLine(null);
    setSelectedPly(null);
    setSelectedFen(protectedRoot);
    await reload();
    onDataChange();
  }

  async function handleDeleteOpeningPrep() {
    if (!selectedFolder) return;
    const ok = window.confirm(`Delete all prep for "${selectedFolder.name}" inside "${repertoire.name}"? Shared earlier moves may remain if other openings use them.`);
    if (!ok) return;
    const incoming = selectedFolder.path[selectedFolder.path.length - 1] ?? null;
    await deleteOpeningFolderInRepertoire(repertoire.id, selectedFolder.baseFen, incoming?.id ?? null);
    onOpeningChange(null);
    setSelectedLine(null);
    setSelectedPly(null);
    setSelectedFen(repertoire.rootFen);
    await reload();
    onDataChange();
  }

  async function handleResetEdgeSrs(edge: Edge) {
    const ok = window.confirm(`Reset SRS state for "${edge.san}"? It will be due again immediately.`);
    if (!ok) return;
    await putEdge({ ...edge, ...freshSrsState() });
    await reload();
    onDataChange();
  }

  async function handleResetAllSrs() {
    const ok = window.confirm(`Reset SRS state for ALL stored moves in "${repertoire.name}"?`);
    if (!ok) return;
    const n = await resetAllSrsForRepertoire(repertoire.id);
    await reload();
    onDataChange();
    alert(`Reset ${n} cards.`);
  }

  // Find inbound edge for currently displayed fen (for SRS panel and orientation).
  const inEdges = useMemo(() => edges.filter(e => e.childFen === displayedFen), [edges, displayedFen]);
  const userInEdges = useMemo(() => inEdges.filter(e => e.mover === repertoire.color && !e.isScaffold), [inEdges, repertoire.color]);
  const orientation: 'white' | 'black' = repertoire.color === 'w' ? 'white' : 'black';
  const scopeTitle = selectedFolder ? `${repertoire.name} / ${selectedFolder.name}` : repertoire.name;
  const browseBoardSize = Math.min(boardSize, 560);

  return (
    <>
    {onBack && (
      <div className="subview-back-row">
        <button onClick={onBack}>Back</button>
      </div>
    )}
    <div className="layout focused-subview">
      <div>
        <div className="page-header compact">
          <div>
            <div className="eyebrow">Lines</div>
            <h1>{scopeTitle}</h1>
          </div>
        </div>
        <Board
          fen={displayedFen}
          orientation={orientation}
          allowMoves={false}
          onMove={() => false}
          highlights={selectedLineLastMove ? lastMoveHighlights(selectedLineLastMove) : undefined}
          size={browseBoardSize}
          maxSize={560}
          resizable
          onSizeChange={onBoardSizeChange}
          historyIndex={selectedLine ? selectedPly ?? selectedLine.path.length : undefined}
          historyLength={selectedLine ? selectedLine.path.length : undefined}
          onHistoryIndexChange={selectedLine ? setSelectedPly : undefined}
        />
        {selectedLine && (
          <div className="panel selected-line-panel">
            <h3>Selected line</h3>
            <div className="small mono" style={{ wordBreak: 'break-word' }}>{selectedLine.fullSan || '(repertoire root)'}</div>
            <div className="small muted" style={{ marginTop: 4 }}>
              Ply {selectedPly ?? selectedLine.path.length} / {selectedLine.path.length}. Use left/right arrow keys to scrub.
            </div>
            {selectedLine.categoryName && (
              <div className="small muted" style={{ marginTop: 4 }}>
                {selectedLine.categoryEco ? `[${selectedLine.categoryEco}] ` : ''}{selectedLine.categoryName}
              </div>
            )}
            <SelectedLineEval line={selectedLine} color={repertoire.color} />
          </div>
        )}
        <details className="collapsible" style={{ marginTop: 8 }}>
          <summary>Manage</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="danger" onClick={handleDeleteSubtree} disabled={displayedFen === repertoire.rootFen || displayedFen === selectedFolder?.baseFen}>
              Delete subtree
            </button>
            <button className="danger" onClick={handleDeleteOpeningPrep} disabled={!selectedFolder}>
              Delete this opening prep
            </button>
            <button onClick={handleResetAllSrs}>Reset all SRS state</button>
          </div>
        </details>
      </div>

      <div>
        <div className="panel">
          <h3>{scopeTitle}</h3>
          {openingFolders.length > 0 && (
            <div className="row" style={{ marginBottom: 10 }}>
              <label className="small muted" htmlFor="browse-opening-folder">Opening folder</label>
              <select
                id="browse-opening-folder"
                value={selectedFolder?.key ?? ''}
                onChange={e => onOpeningChange(e.target.value || null)}
              >
                <option value="">All openings</option>
                {openingFolders.map(folder => (
                  <option key={folder.key} value={folder.key}>{folder.name}</option>
                ))}
              </select>
            </div>
          )}
          {openingFolders.length === 0 ? (
            <div className="settings-empty-drop empty-state">No openings yet. Add your first opening.</div>
          ) : visibleLines.length === 0 ? (
            <div className="settings-empty-drop empty-state">No lines in this opening yet.</div>
          ) : (
            <div>
              {groups.map(g => (
                <OpeningGroupView
                  key={g.fen ?? '__none__'}
                  group={g}
                  selectedLeafFen={selectedLine?.leafFen ?? null}
                  onSelect={selectLine}
                  repertoireColor={repertoire.color}
                  boardThumbSize={112}
                />
              ))}
            </div>
          )}
        </div>

        {userInEdges.length > 0 && (
          <div className="panel">
            <h3>Your incoming move (SRS)</h3>
            <table className="lichess-table">
              <thead>
                <tr><th>Move</th><th>Reps</th><th>Ease</th><th>Interval</th><th>Due</th><th></th></tr>
              </thead>
              <tbody>
                {userInEdges.map(e => (
                  <tr key={e.id}>
                    <td className="mono">{e.san}</td>
                    <td>{e.reps}</td>
                    <td>{e.ease.toFixed(2)}</td>
                    <td>{e.intervalDays}d</td>
                    <td className="small">{new Date(e.dueAt).toLocaleDateString()}</td>
                    <td><button onClick={() => handleResetEdgeSrs(e)}>Reset</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <details className="collapsible">
          <summary>Raw tree</summary>
          <div style={{ marginTop: 8 }}>
            <TreeView
              nodes={nodes}
              edges={visibleEdges}
              currentFen={displayedFen}
              rootFen={selectedFolder?.baseFen ?? repertoire.rootFen}
              onSelect={selectFen}
            />
          </div>
        </details>
      </div>
    </div>
    </>
  );
}

function lineBelongsToFolder(line: LineItem, folder: OpeningFolder): boolean {
  if (folder.path.length === 0) return true;
  if (line.path.length < folder.path.length) return false;
  return folder.path.every((edge, idx) => line.path[idx]?.id === edge.id);
}

function subtreeEdges(rootFen: NormFen, edges: Edge[]): Edge[] {
  const byParent = new Map<NormFen, Edge[]>();
  for (const edge of edges) {
    const current = byParent.get(edge.parentFen) ?? [];
    current.push(edge);
    byParent.set(edge.parentFen, current);
  }

  const result: Edge[] = [];
  const stack = [rootFen];
  const visited = new Set<NormFen>();
  while (stack.length) {
    const fen = stack.pop()!;
    if (visited.has(fen)) continue;
    visited.add(fen);
    for (const edge of byParent.get(fen) ?? []) {
      result.push(edge);
      stack.push(edge.childFen);
    }
  }
  return result;
}

function SelectedLineEval({ line, color }: { line: LineItem; color: Repertoire['color'] }) {
  const [evalCp, setEvalCp] = useState<number | null | undefined>(undefined);
  const mistakeEdge = line.path.find(edge => edge.mover !== color && edge.isMistake);

  useEffect(() => {
    let cancelled = false;
    setEvalCp(undefined);
    (async () => {
      try {
        const evaluation = await fetchCloudEval(line.leafFen, 1);
        if (cancelled) return;
        if (!evaluation || evaluation.pvs.length === 0) {
          setEvalCp(null);
          return;
        }
        setEvalCp(pvCpForColor(evaluation.pvs[0], color));
      } catch {
        if (cancelled) return;
        setEvalCp(null);
      }
    })();
    return () => { cancelled = true; };
  }, [line.leafFen, color]);

  return (
    <div className={'line-eval-inline' + (mistakeEdge ? ' punishing' : '')}>
      <span>{mistakeEdge ? 'Punishing' : 'Continuing'}</span>
      <strong>{formatLineEval(evalCp)}</strong>
    </div>
  );
}

function formatLineEval(cp: number | null | undefined): string {
  if (cp === undefined) return '...';
  if (cp === null) return 'No cloud eval';
  if (Math.abs(cp) > 90000) return cp > 0 ? 'Winning mate' : 'Mated';
  const pawns = cp / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

function countAllLines(folder: OpeningGroup | VariationFolder): number {
  let count = folder.lines.length;
  for (const subfolder of folder.subfolders) {
    count += countAllLines(subfolder);
  }
  return count;
}

function OpeningGroupView({ group, selectedLeafFen, onSelect, repertoireColor, boardThumbSize }: {
  group: OpeningGroup;
  selectedLeafFen: NormFen | null;
  onSelect: (l: LineItem) => void;
  repertoireColor: Repertoire['color'];
  boardThumbSize: number;
}) {
  const [open, setOpen] = useState(false);
  const previewLine = group.lines[0] ?? group.subfolders[0]?.lines[0] ?? null;
  const previewFen = group.fen ?? previewLine?.leafFen ?? null;
  const previewOrientation: 'white' | 'black' = repertoireColor === 'w' ? 'white' : 'black';
  const totalLineCount = countAllLines(group);

  return (
    <div className={'opening-folder' + (open ? ' open' : ' closed')}>
      <div
        onClick={() => setOpen(o => !o)}
        className="opening-folder-head"
      >
        {previewFen && (
          <div className="folder-preview-board" style={{ pointerEvents: 'none' }}>
            <BoardThumbnail fen={previewFen} orientation={previewOrientation} size={72} />
          </div>
        )}
        <span className="folder-eco mono small muted">{group.eco ?? '-'}</span>
        <strong className="folder-title">{group.name}</strong>
        <span className="folder-count muted small">{totalLineCount} line{totalLineCount === 1 ? '' : 's'}</span>
        <span className="spacer" />
        <span className="folder-toggle muted small">{open ? 'v' : '>'}</span>
      </div>
      {open && (
        <>
          {group.subfolders.length > 0 && (
            <div style={{ paddingLeft: '12px' }}>
              {group.subfolders.map(sf => (
                <VariationFolderView
                  key={sf.fen}
                  folder={sf}
                  selectedLeafFen={selectedLeafFen}
                  onSelect={onSelect}
                  repertoireColor={repertoireColor}
                  boardThumbSize={boardThumbSize}
                />
              ))}
            </div>
          )}
          {group.lines.length > 0 && group.subfolders.length > 0 && (
            <OtherPositionsFolder
              lines={group.lines}
              selectedLeafFen={selectedLeafFen}
              onSelect={onSelect}
              boardThumbSize={boardThumbSize}
              repertoireColor={repertoireColor}
            />
          )}
          {group.lines.length > 0 && group.subfolders.length === 0 && (
            <LineGrid
              lines={group.lines}
              selectedLeafFen={selectedLeafFen}
              onSelect={onSelect}
              boardThumbSize={boardThumbSize}
              repertoireColor={repertoireColor}
            />
          )}
        </>
      )}
    </div>
  );
}

function VariationFolderView({ folder, selectedLeafFen, onSelect, repertoireColor, boardThumbSize }: {
  folder: VariationFolder;
  selectedLeafFen: NormFen | null;
  onSelect: (l: LineItem) => void;
  repertoireColor: Repertoire['color'];
  boardThumbSize: number;
}) {
  const [open, setOpen] = useState(false);
  const previewFen = folder.fen;
  const previewOrientation: 'white' | 'black' = repertoireColor === 'w' ? 'white' : 'black';
  const totalLineCount = countAllLines(folder);

  return (
    <div className={'variation-folder' + (open ? ' open' : ' closed')}>
      <div
        onClick={() => setOpen(o => !o)}
        className="variation-folder-head"
      >
        <div className="folder-preview-board" style={{ pointerEvents: 'none' }}>
          <BoardThumbnail fen={previewFen} orientation={previewOrientation} size={52} />
        </div>
        <strong className="folder-title">{folder.label}</strong>
        <span className="folder-count muted small">{totalLineCount} line{totalLineCount === 1 ? '' : 's'}</span>
        <span className="spacer" />
        <span className="folder-toggle muted small">{open ? 'v' : '>'}</span>
      </div>
      {open && (
        <>
          {folder.subfolders.length > 0 && (
            <div style={{ paddingLeft: '12px' }}>
              {folder.subfolders.map(sf => (
                <VariationFolderView
                  key={sf.fen}
                  folder={sf}
                  selectedLeafFen={selectedLeafFen}
                  onSelect={onSelect}
                  repertoireColor={repertoireColor}
                  boardThumbSize={boardThumbSize}
                />
              ))}
            </div>
          )}
          {folder.lines.length > 0 && (
            <LineGrid
              lines={folder.lines}
              selectedLeafFen={selectedLeafFen}
              onSelect={onSelect}
              boardThumbSize={boardThumbSize}
              repertoireColor={repertoireColor}
            />
          )}
        </>
      )}
    </div>
  );
}

function OtherPositionsFolder({ lines, selectedLeafFen, onSelect, boardThumbSize, repertoireColor }: {
  lines: LineItem[];
  selectedLeafFen: NormFen | null;
  onSelect: (l: LineItem) => void;
  boardThumbSize: number;
  repertoireColor: Repertoire['color'];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={'variation-folder other-positions-folder' + (open ? ' open' : ' closed')}>
      <div className="variation-folder-head other-positions-head" onClick={() => setOpen(o => !o)}>
        <strong className="folder-title">Other Positions</strong>
        <span className="folder-count muted small">{lines.length} line{lines.length === 1 ? '' : 's'}</span>
        <span className="spacer" />
        <span className="folder-toggle muted small">{open ? 'v' : '>'}</span>
      </div>
      {open && (
        <LineGrid
          lines={lines}
          selectedLeafFen={selectedLeafFen}
          onSelect={onSelect}
          boardThumbSize={boardThumbSize}
          repertoireColor={repertoireColor}
        />
      )}
    </div>
  );
}

function LineGrid({ lines, selectedLeafFen, onSelect, boardThumbSize, repertoireColor }: {
  lines: LineItem[];
  selectedLeafFen: NormFen | null;
  onSelect: (l: LineItem) => void;
  boardThumbSize: number;
  repertoireColor: Repertoire['color'];
}) {
  return (
    <div className="opening-lines-grid">
      {lines.map(l => (
        <LineCard
          key={l.leafFen + l.fullSan}
          line={l}
          selected={l.leafFen === selectedLeafFen}
          onClick={() => onSelect(l)}
          boardSize={boardThumbSize}
          repertoireColor={repertoireColor}
        />
      ))}
    </div>
  );
}

function LineCard({ line, selected, onClick, boardSize, repertoireColor }: {
  line: LineItem;
  selected: boolean;
  onClick: () => void;
  boardSize: number;
  repertoireColor: Repertoire['color'];
}) {
  const orientation: 'white' | 'black' = repertoireColor === 'w' ? 'white' : 'black';
  return (
    <div
      className={'line-card' + (selected ? ' selected' : '')}
      onClick={onClick}
    >
      <div className="line-card-board" style={{ pointerEvents: 'none' }}>
        <BoardThumbnail fen={line.leafFen} orientation={orientation} size={boardSize} />
      </div>
      <div className="line-card-copy mono small">
        {line.extensionSan || line.fullSan || <span className="muted">(repertoire root)</span>}
      </div>
    </div>
  );
}
