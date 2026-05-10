import { useEffect, useMemo, useState, useCallback } from 'react';
import { Board } from '../components/Board';
import { TreeView } from '../components/TreeView';
import { deleteSubtreeInRepertoire, getEdgesForRepertoire, getAllNodes, putEdge, resetAllSrsForRepertoire } from '../lib/storage';
import { freshSrsState } from '../lib/srs';
import { pvCpForColor } from '../lib/autosuggest';
import { fetchCloudEval } from '../lib/lichess';
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

function buildLines(rootFen: NormFen, edges: Edge[]): LineItem[] {
  // Build adjacency: parent → outgoing edges
  const byParent = new Map<NormFen, Edge[]>();
  for (const e of edges) {
    let arr = byParent.get(e.parentFen);
    if (!arr) { arr = []; byParent.set(e.parentFen, arr); }
    arr.push(e);
  }
  // DFS from root, generating one LineItem per leaf.
  const lines: LineItem[] = [];
  function dfs(curFen: NormFen, pathSoFar: Edge[]) {
    const out = byParent.get(curFen) || [];
    if (out.length === 0) {
      // Leaf
      lines.push(makeLineItem(rootFen, curFen, pathSoFar));
      return;
    }
    for (const e of out) {
      dfs(e.childFen, [...pathSoFar, e]);
    }
  }
  dfs(rootFen, []);
  return lines;
}

function makeLineItem(rootFen: NormFen, leafFen: NormFen, path: Edge[]): LineItem {
  // Walk from leaf back toward root, find deepest ECO-named position.
  let categoryFen: NormFen | null = null;
  let categoryName: string | null = null;
  let categoryEco: string | null = null;
  let categoryIdx = -1; // position in path (0 = after edge[0], -1 = root)

  // Check root first — many openings start at the root position equivalent.
  const rootMatch = lookupOpening(rootFen);
  if (rootMatch) {
    categoryFen = rootFen;
    categoryName = rootMatch.name;
    categoryEco = rootMatch.eco;
    categoryIdx = -1;
  }

  for (let i = 0; i < path.length; i++) {
    const fen = path[i].childFen;
    const m = lookupOpening(fen);
    if (m) {
      categoryFen = fen;
      categoryName = m.name;
      categoryEco = m.eco;
      categoryIdx = i;
    }
  }

  const extensionEdges = path.slice(categoryIdx + 1);
  const extensionSan = renderSanFromEdges(extensionEdges, categoryIdx + 1);
  const fullSan = renderSanFromEdges(path);
  return { leafFen, path, categoryFen, categoryName, categoryEco, extensionSan, fullSan };
}

function renderSanFromEdges(edges: Edge[], startingPly = 0): string {
  const out: string[] = [];
  let moveNum = Math.floor(startingPly / 2) + 1;
  let ply = startingPly;
  // We need to know the starting move number: derive from the first edge's mover.
  // If first edge mover === 'b', that's "1...e5" style; we treat that as starting at move 1 black.
  // For simplicity: use full move numbers based on absolute position (we don't have ply count handy
  // — just emit "X." before white moves).
  for (const e of edges) {
    if (e.mover === 'w') {
      out.push(`${moveNum}.`);
      out.push(e.san);
    } else {
      if (ply === startingPly) out.push(`${moveNum}...`);
      out.push(e.san);
      moveNum++;
    }
    ply++;
  }
  return out.join(' ');
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
  onDataChange: () => void;
  refreshKey: number;
  boardSize: number;
  onBoardSizeChange: (size: number) => void;
}

export function BrowseMode({ repertoire, onDataChange, refreshKey, boardSize, onBoardSizeChange }: BrowseModeProps) {
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

  const lines = useMemo(() => buildLines(repertoire.rootFen, edges), [repertoire.rootFen, edges]);
  const groups = useMemo(() => groupLines(lines, edges), [lines, edges]);

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
    if (displayedFen === repertoire.rootFen) {
      alert("Can't delete the repertoire's root position.");
      return;
    }
    const ok = window.confirm('Delete this position and all branches below it (in this repertoire)? This cannot be undone.');
    if (!ok) return;
    await deleteSubtreeInRepertoire(repertoire.id, displayedFen);
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

  return (
    <div className="layout">
      <div>
        <Board
          fen={displayedFen}
          orientation={orientation}
          allowMoves={false}
          onMove={() => false}
          highlights={selectedLineLastMove ? lastMoveHighlights(selectedLineLastMove) : undefined}
          size={boardSize}
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
            <button className="danger" onClick={handleDeleteSubtree} disabled={displayedFen === repertoire.rootFen}>
              Delete subtree
            </button>
            <button onClick={handleResetAllSrs}>Reset all SRS state</button>
          </div>
        </details>
      </div>

      <div>
        <div className="panel">
          <h3>Lines - {repertoire.name} ({repertoire.color === 'w' ? 'White' : 'Black'})</h3>
          {lines.length === 0 ? (
            <div className="muted small">No lines yet. Run a Train session to start populating the repertoire.</div>
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
              edges={edges}
              currentFen={displayedFen}
              rootFen={repertoire.rootFen}
              onSelect={selectFen}
            />
          </div>
        </details>
      </div>
    </div>
  );
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
            <Board
              fen={previewFen}
              orientation={previewOrientation}
              onMove={() => false}
              allowMoves={false}
              size={72}
              showNotation={false}
            />
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
          <Board
            fen={previewFen}
            orientation={previewOrientation}
            onMove={() => false}
            allowMoves={false}
            size={52}
            showNotation={false}
          />
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
        <Board
          fen={line.leafFen}
          orientation={orientation}
          onMove={() => false}
          allowMoves={false}
          size={boardSize}
          showNotation={false}
        />
      </div>
      <div className="line-card-copy mono small">
        {line.extensionSan || <span className="muted">(at the named position)</span>}
      </div>
    </div>
  );
}
