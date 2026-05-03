import { useMemo, useState } from 'react';
import type { Edge, NormFen, PositionNode } from '../types';
import { STARTING_FEN_NORM } from '../lib/chess';

export interface TreeViewProps {
  nodes: Map<NormFen, PositionNode>;
  edges: Edge[];
  // Highlight the current node and (optionally) the path of FENs leading to it.
  currentFen?: NormFen;
  pathFens?: NormFen[];
  onSelect: (fen: NormFen) => void;
  // FEN to start the tree from. Defaults to root.
  rootFen?: NormFen;
  // Mark edges that are due now.
  nowMs?: number;
}

interface EdgeIndex {
  byParent: Map<NormFen, Edge[]>;
}

function buildIndex(edges: Edge[]): EdgeIndex {
  const byParent = new Map<NormFen, Edge[]>();
  for (const e of edges) {
    let arr = byParent.get(e.parentFen);
    if (!arr) { arr = []; byParent.set(e.parentFen, arr); }
    arr.push(e);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.san.localeCompare(b.san));
  }
  return { byParent };
}

export function TreeView({ nodes, edges, currentFen, pathFens, onSelect, rootFen = STARTING_FEN_NORM, nowMs = Date.now() }: TreeViewProps) {
  const idx = useMemo(() => buildIndex(edges), [edges]);
  const [collapsed, setCollapsed] = useState<Set<NormFen>>(new Set());

  function toggle(fen: NormFen) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(fen)) next.delete(fen); else next.add(fen);
      return next;
    });
  }

  const pathSet = useMemo(() => new Set(pathFens || []), [pathFens]);

  function renderNode(fen: NormFen, fromEdge: Edge | null, depth: number, visited: Set<NormFen>): React.ReactNode {
    if (visited.has(fen) || depth > 40) {
      // Cycle guard (transpositions can theoretically loop; depth cap as safety).
      return null;
    }
    const childEdges = idx.byParent.get(fen) || [];
    const isCurrent = currentFen === fen;
    const isOnPath = pathSet.has(fen);
    const isCollapsed = collapsed.has(fen);
    const hasChildren = childEdges.length > 0;
    const due = fromEdge && new Date(fromEdge.dueAt).getTime() <= nowMs;
    const label = fromEdge ? fromEdge.san : 'start';
    const newVisited = new Set(visited);
    newVisited.add(fen);

    return (
      <div className={'tree-node' + (depth === 0 ? ' root' : '')} key={fen + (fromEdge?.id || '')}>
        <div
          className={'tree-row' + (isCurrent ? ' current' : '') + (isOnPath && !isCurrent ? ' selected' : '')}
          onClick={() => onSelect(fen)}
        >
          <span
            className="toggle"
            onClick={(e) => { e.stopPropagation(); if (hasChildren) toggle(fen); }}
            title={hasChildren ? (isCollapsed ? 'Expand' : 'Collapse') : ''}
          >
            {hasChildren ? (isCollapsed ? '▶' : '▼') : '·'}
          </span>
          <span>{label}</span>
          {due && <span className="due-dot" title="due"></span>}
          {childEdges.length > 0 && <span className="muted small">({childEdges.length})</span>}
        </div>
        {!isCollapsed && hasChildren && (
          <div>
            {childEdges.map(e => {
              if (!nodes.has(e.childFen)) return null;
              return renderNode(e.childFen, e, depth + 1, newVisited);
            })}
          </div>
        )}
      </div>
    );
  }

  if (!nodes.has(rootFen)) {
    return <div className="muted small">No tree yet.</div>;
  }
  return <div className="tree">{renderNode(rootFen, null, 0, new Set())}</div>;
}
