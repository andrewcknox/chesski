import type { Color, Edge, NormFen } from '../types';

export interface OpeningLookup {
  eco: string;
  name: string;
}

export interface PreparedLineItem {
  leafFen: NormFen;
  path: Edge[];
  categoryFen: NormFen | null;
  categoryName: string | null;
  categoryEco: string | null;
  extensionSan: string;
  fullSan: string;
}

export function buildPreparedLineItems(
  rootFen: NormFen,
  edges: Edge[],
  color: Color,
  lookupOpening: (fen: NormFen) => OpeningLookup | null = () => null,
): PreparedLineItem[] {
  const byParent = new Map<NormFen, Edge[]>();
  for (const edge of edges) {
    const children = byParent.get(edge.parentFen) ?? [];
    children.push(edge);
    byParent.set(edge.parentFen, children);
  }

  const byEndpoint = new Map<NormFen, Edge[]>();
  const stack: Array<{ fen: NormFen; path: Edge[]; seen: Set<NormFen> }> = [
    { fen: rootFen, path: [], seen: new Set([rootFen]) },
  ];
  const maxPathLength = Math.max(160, edges.length + 1);

  while (stack.length) {
    const { fen: curFen, path, seen } = stack.pop()!;
    const out = byParent.get(curFen) ?? [];
    if (out.length === 0) {
      addPreparedEndpoint(path);
      continue;
    }
    for (const edge of out) {
      const nextPath = [...path, edge];
      if (seen.has(edge.childFen) || nextPath.length > maxPathLength) {
        addPreparedEndpoint(nextPath);
        continue;
      }
      const nextSeen = new Set(seen);
      nextSeen.add(edge.childFen);
      stack.push({ fen: edge.childFen, path: nextPath, seen: nextSeen });
    }
  }

  function addPreparedEndpoint(path: Edge[]) {
    if (path.length === 0) {
      byEndpoint.set(rootFen, []);
      return;
    }
    let endpointIdx = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].mover === color) {
        endpointIdx = i;
        break;
      }
    }
    if (endpointIdx < 0) return;
    const endpointPath = path.slice(0, endpointIdx + 1);
    const endpoint = endpointPath[endpointPath.length - 1];
    if (!endpoint) return;
    const existing = byEndpoint.get(endpoint.childFen);
    if (!existing || endpointPath.length > existing.length) {
      byEndpoint.set(endpoint.childFen, endpointPath);
    }
  }

  const lines = Array.from(byEndpoint.entries()).map(([leafFen, path]) =>
    makePreparedLineItem(rootFen, leafFen, path, lookupOpening)
  );
  lines.sort((a, b) => a.fullSan.localeCompare(b.fullSan) || a.leafFen.localeCompare(b.leafFen));
  return lines;
}

function makePreparedLineItem(
  rootFen: NormFen,
  leafFen: NormFen,
  path: Edge[],
  lookupOpening: (fen: NormFen) => OpeningLookup | null,
): PreparedLineItem {
  let categoryFen: NormFen | null = null;
  let categoryName: string | null = null;
  let categoryEco: string | null = null;
  let categoryIdx = -1;

  const rootMatch = lookupOpening(rootFen);
  if (rootMatch) {
    categoryFen = rootFen;
    categoryName = rootMatch.name;
    categoryEco = rootMatch.eco;
  }

  for (let i = 0; i < path.length; i++) {
    const match = lookupOpening(path[i].childFen);
    if (match) {
      categoryFen = path[i].childFen;
      categoryName = match.name;
      categoryEco = match.eco;
      categoryIdx = i;
    }
  }

  const extensionEdges = path.slice(categoryIdx + 1);
  return {
    leafFen,
    path,
    categoryFen,
    categoryName,
    categoryEco,
    extensionSan: renderSanFromEdges(extensionEdges, categoryIdx + 1),
    fullSan: renderSanFromEdges(path),
  };
}

export function renderSanFromEdges(edges: Edge[], startingPly = 0): string {
  const out: string[] = [];
  let moveNum = Math.floor(startingPly / 2) + 1;
  let ply = startingPly;
  for (const edge of edges) {
    if (edge.mover === 'w') {
      out.push(`${moveNum}.`);
      out.push(edge.san);
    } else {
      if (ply === startingPly) out.push(`${moveNum}...`);
      out.push(edge.san);
      moveNum++;
    }
    ply++;
  }
  return out.join(' ');
}
