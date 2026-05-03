import { useEffect, useMemo, useState, useCallback } from 'react';
import { Board } from '../components/Board';
import { TreeView } from '../components/TreeView';
import { deleteSubtreeInRepertoire, getEdgesForRepertoire, getAllNodes, putEdge, resetAllSrsForRepertoire } from '../lib/storage';
import { freshSrsState } from '../lib/srs';
import { turnAt } from '../lib/chess';
import { pvCpForSide } from '../lib/autosuggest';
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
  const extensionSan = renderSanFromEdges(extensionEdges);
  const fullSan = renderSanFromEdges(path);
  return { leafFen, path, categoryFen, categoryName, categoryEco, extensionSan, fullSan };
}

function renderSanFromEdges(edges: Edge[]): string {
  const out: string[] = [];
  let moveNum = 1;
  // We need to know the starting move number: derive from the first edge's mover.
  // If first edge mover === 'b', that's "1...e5" style; we treat that as starting at move 1 black.
  // For simplicity: use full move numbers based on absolute position (we don't have ply count handy
  // — just emit "X." before white moves).
  for (const e of edges) {
    if (e.mover === 'w') { out.push(`${moveNum}.`); out.push(e.san); }
    else { out.push(e.san); moveNum++; }
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
}

function groupLines(lines: LineItem[]): OpeningGroup[] {
  const map = new Map<string, OpeningGroup>();
  for (const l of lines) {
    const key = l.categoryFen ?? '__none__';
    let g = map.get(key);
    if (!g) {
      g = {
        fen: l.categoryFen,
        eco: l.categoryEco,
        name: l.categoryName ?? 'Unnamed positions',
        lines: [],
      };
      map.set(key, g);
    }
    g.lines.push(l);
  }
  // Sort groups by ECO code (alphabetical), unnamed last.
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
  const groups = useMemo(() => groupLines(lines), [lines]);

  // The displayed FEN: line's leaf if a line is selected; otherwise the manually-selected fen.
  const displayedFen = selectedLine
    ? selectedPly === 0
      ? repertoire.rootFen
      : selectedLine.path[Math.max(0, (selectedPly ?? selectedLine.path.length) - 1)]?.childFen ?? selectedLine.leafFen
    : selectedFen;
  const selectedLineLastMove = selectedLine && selectedPly && selectedPly > 0
    ? selectedLine.path[selectedPly - 1] ?? null
    : null;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (!selectedLine || selectedPly === null) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setSelectedPly(p => {
        const cur = p ?? selectedLine.path.length;
        return e.key === 'ArrowLeft'
          ? Math.max(0, cur - 1)
          : Math.min(selectedLine.path.length, cur + 1);
      });
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedLine, selectedPly]);

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
  const userInEdges = useMemo(() => inEdges.filter(e => e.mover === repertoire.color), [inEdges, repertoire.color]);
  const primaryInEdge = inEdges[0] ?? null;
  const orientation: 'white' | 'black' = primaryInEdge ? (primaryInEdge.mover === 'w' ? 'black' : 'white') : (repertoire.color === 'w' ? 'white' : 'black');

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
        />
        {selectedLine && (
          <div className="panel" style={{ marginTop: 10 }}>
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
          <h3>Lines — {repertoire.name} ({repertoire.color === 'w' ? 'White' : 'Black'})</h3>
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
                  boardThumbSize={140}
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
        const cp = pvCpForSide(evaluation.pvs[0]);
        setEvalCp(cp === null ? null : turnAt(line.leafFen) === color ? cp : -cp);
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

function OpeningGroupView({ group, selectedLeafFen, onSelect, repertoireColor, boardThumbSize }: {
  group: OpeningGroup;
  selectedLeafFen: NormFen | null;
  onSelect: (l: LineItem) => void;
  repertoireColor: Repertoire['color'];
  boardThumbSize: number;
}) {
  const [open, setOpen] = useState(true);
  const previewLine = group.lines[0] ?? null;
  const previewFen = group.fen ?? previewLine?.leafFen ?? null;
  const previewOrientation: 'white' | 'black' = repertoireColor === 'w' ? 'white' : 'black';
  return (
    <div className="opening-folder">
      <div
        onClick={() => setOpen(o => !o)}
        className="opening-folder-head"
      >
        {previewFen && (
          <div className="folder-preview-board" style={{ pointerEvents: 'none' }}>
            <Board fen={previewFen} orientation={previewOrientation} onMove={() => false} allowMoves={false} size={92} />
          </div>
        )}
        <span className="mono small muted" style={{ minWidth: 36 }}>{group.eco ?? '—'}</span>
        <strong>{group.name}</strong>
        <span className="muted small">· {group.lines.length} line{group.lines.length === 1 ? '' : 's'}</span>
        <span className="spacer" />
        <span className="muted small">{open ? '▼' : '▶'}</span>
      </div>
      {open && (
        <div className="opening-lines-grid">
          {group.lines.map(l => (
            <LineCard
              key={l.leafFen + l.fullSan}
              line={l}
              selected={l.leafFen === selectedLeafFen}
              onClick={() => onSelect(l)}
              boardSize={boardThumbSize}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LineCard({ line, selected, onClick, boardSize }: { line: LineItem; selected: boolean; onClick: () => void; boardSize: number }) {
  // Pick orientation based on the last edge's mover (the side that just moved).
  const lastEdge = line.path[line.path.length - 1];
  const orientation: 'white' | 'black' = lastEdge?.mover === 'w' ? 'black' : 'white';
  return (
    <div
      onClick={onClick}
      style={{
        padding: 6, borderRadius: 4, cursor: 'pointer',
        border: '1px solid ' + (selected ? 'var(--accent)' : 'var(--border)'),
        background: selected ? 'var(--accent-dim)' : 'var(--bg-elev)',
      }}
    >
      <div style={{ pointerEvents: 'none' }}>
        <Board fen={line.leafFen} orientation={orientation} onMove={() => false} allowMoves={false} size={boardSize} />
      </div>
      <div className="mono small" style={{ marginTop: 6, wordBreak: 'break-word' }}>
        {line.extensionSan || <span className="muted">(at the named position)</span>}
      </div>
    </div>
  );
}
