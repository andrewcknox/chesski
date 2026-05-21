// Paste this entire script into the browser DevTools console while on the Andy account.
// It removes non-Italian Game edges (Sicilian, Scandinavian, etc.) that were added
// to Italian Game repertoires by an old version of the line generation algorithm.
//
// What it does:
//   1. Finds all Italian Game repertoires in IndexedDB
//   2. Identifies the scaffold positions (1.e4 e5 2.Nf3 Nc6 3.Bc4 and the path to them)
//   3. Finds contamination edges: non-scaffold opponent moves at those scaffold positions
//      (e.g. 1...c5, 1...d5, 1...e6 at the position after 1.e4)
//   4. Collects all descendants of those edges
//   5. Shows you what will be deleted, asks for confirmation, then deletes

(async function cleanItalianGame() {
  const DB_NAME = 'chess-trainer';

  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  function getAllFromIndex(db, storeName, indexName, query) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).index(indexName).getAll(query);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function getAll(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // --- Find Italian Game repertoires ---
  const allReps = await getAll(db, 'repertoires');
  console.log('All repertoires:', allReps.map(r => `"${r.name}" (${r.openingKey ?? 'custom'})`).join(', '));

  const italianReps = allReps.filter(r =>
    r.openingKey?.includes('italian') || r.name.toLowerCase().includes('italian')
  );

  if (italianReps.length === 0) {
    console.warn('No Italian Game repertoires found. Make sure you are logged in as Andy.');
    db.close();
    return;
  }

  console.log(`Found ${italianReps.length} Italian repertoire(s): ${italianReps.map(r => r.name).join(', ')}`);

  const allToDelete = new Map(); // edgeId -> { san, parentFen } for reporting

  for (const rep of italianReps) {
    console.log(`\n--- Scanning: "${rep.name}" ---`);

    const allEdges = await getAllFromIndex(db, 'edges', 'by-repertoire', rep.id);
    console.log(`  Total edges: ${allEdges.length}`);

    const byParent = new Map();
    const byId = new Map();
    for (const edge of allEdges) {
      byId.set(edge.id, edge);
      if (!byParent.has(edge.parentFen)) byParent.set(edge.parentFen, []);
      byParent.get(edge.parentFen).push(edge);
    }

    // Phase 1: walk only scaffold edges to find scaffold positions
    const scaffoldPositions = new Set([rep.rootFen]);
    const stack = [rep.rootFen];
    const visited = new Set();

    while (stack.length) {
      const fen = stack.pop();
      if (visited.has(fen)) continue;
      visited.add(fen);
      for (const edge of (byParent.get(fen) ?? [])) {
        if (edge.isScaffold) {
          scaffoldPositions.add(edge.childFen);
          stack.push(edge.childFen);
        }
      }
    }

    console.log(`  Scaffold positions: ${scaffoldPositions.size}`);

    // Phase 2: find contamination edges (non-scaffold opponent moves at scaffold positions)
    const contamination = new Set();
    for (const fen of scaffoldPositions) {
      for (const edge of (byParent.get(fen) ?? [])) {
        if (edge.mover !== rep.color && !edge.isScaffold) {
          console.log(`  Contamination: ${edge.san} (${edge.uci}) — opponent move at scaffold position`);
          contamination.add(edge.id);
        }
      }
    }

    if (contamination.size === 0) {
      console.log('  No contamination found — already clean.');
      continue;
    }

    // Phase 3: BFS to collect all descendants of contaminated edges
    const toDelete = new Set(contamination);
    const bfsQueue = [...contamination];

    while (bfsQueue.length) {
      const id = bfsQueue.shift();
      const edge = byId.get(id);
      if (!edge) continue;
      for (const child of (byParent.get(edge.childFen) ?? [])) {
        if (!toDelete.has(child.id)) {
          toDelete.add(child.id);
          bfsQueue.push(child.id);
        }
      }
    }

    console.log(`  Edges to delete: ${toDelete.size} (${contamination.size} contamination roots + ${toDelete.size - contamination.size} descendants)`);

    for (const id of toDelete) {
      const e = byId.get(id);
      if (e) allToDelete.set(id, `${e.san} [${e.uci}]`);
    }
  }

  if (allToDelete.size === 0) {
    console.log('\nNothing to clean up. All Italian repertoires look correct.');
    db.close();
    return;
  }

  console.log(`\nTotal edges to delete: ${allToDelete.size}`);
  console.log('Moves being removed:', [...allToDelete.values()].join(', '));

  const confirmed = confirm(
    `Remove ${allToDelete.size} non-Italian edges from your repertoire(s)?\n\n` +
    `This cleans up Sicilian, Scandinavian, and other off-repertoire lines added by the old algorithm.\n\n` +
    `Click OK to delete, Cancel to abort.`
  );

  if (!confirmed) {
    console.log('Aborted. No changes made.');
    db.close();
    return;
  }

  // Phase 4: delete
  await new Promise((resolve, reject) => {
    const tx = db.transaction('edges', 'readwrite');
    const store = tx.objectStore('edges');
    for (const id of allToDelete.keys()) store.delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });

  db.close();
  console.log(`\n✓ Deleted ${allToDelete.size} edges. Please reload the page (Ctrl+R) to see the changes.`);
})();
