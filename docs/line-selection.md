# Line selection — how Train mode builds a learn line

**Audience: future Claude (and human) sessions inheriting this codebase.**
The user has lost work multiple times to sessions that misunderstood this pipeline
and "fixed" it badly. This doc exists so that doesn't keep happening. Read it
before touching `src/lib/autosuggest.ts`, `src/lib/storage.ts` frontier code, or
`src/modes/TrainMode.tsx` line-related render code.

## Terminology: PTM-F vs OTM-F

A **frontier** is a gap in the repertoire — a position the training session should close. There are two kinds. The code calls them "type-1" / "type-2"; in conversation and in this doc we use these names:

- **PTM-F** (Player-To-Move Frontier; legacy code: "type-1"). Discovered by DFS through stored edges. You walked through your prep, reached a position where it's *your* turn, and have no stored move. The opponent's edge to get here IS already stored; the missing piece is your reply.
- **OTM-F** (Opponent-To-Move Frontier; legacy code: "type-2"). Discovered by querying Lichess Explorer at an opponent-to-move position in your prep. The explorer reports a popular opponent reply that *isn't* in your edges. The missing piece is both the opponent's edge *and* your reply behind it.

Both kinds are stored as the same `FrontierCandidate` shape (`parentFen` + `uci` → `childFen`, where `childFen` is the your-turn position you need to answer). They're ranked together by `games`. The distinction matters when you're reasoning about discovery (Phase 1 produces PTM-F; Phase 2 produces OTM-F) or scaffolding (only OTM-F adds new opponent edges to the repertoire).

## The three algorithms — do not conflate them

A "learn line" in Train mode is built by three independent algorithms that
happen to live in the same file. Conflating them is the most common failure
mode. Memorize this table.

| Algorithm | What it picks | Where it lives | Ranking input |
| --- | --- | --- | --- |
| **Frontier selection** | The next gap (PTM-F or OTM-F) the user should study — its `childFen` is a your-turn position with no stored response | `findTopFrontier` → `findTopUnansweredOpponentMove` in `src/lib/autosuggest.ts` | `FrontierCandidate.games` (raw Lichess game count at the frontier's childFen) |
| **User-move selection** | What *the user* plays at each ply of the generated line (including filling in the gap at the frontier) | `pickYourMove` (with `pickAnyDatabaseMove` / `pickFirstLegalMove` fallbacks), plus `activeSourceLine` follow inside `generateLearnLineOnce` | Player-book → masters → lichess-2000 → engine, in user-configurable order; player-book picks are filtered through the same per-move WDL gate as the quality gate (shared `judgeCandidateAtFen` helper). **`games` plays no role here.** |
| **Opponent-move-in-line** | What the opponent plays *after* the frontier as the line extends | `pickOpponentMoves` | Lichess Explorer popularity at that ply (top fraction); also scaffolds every above-threshold reply into the repertoire |

If you find yourself editing `pickYourMove` because of a complaint about
"weird frontier picks", stop — the frontier picker is in a totally separate
function. And vice versa: a complaint about "the user plays bad moves in the
generated line" is not fixed by changing the frontier sort.

## Frontier selection (the deep dive)

### Definitions

- A **frontier** is a `(parentFen, uci) → childFen` record where `childFen` is a your-turn position with no stored response in your prep. This is the boundary of what you've prepared. Two kinds, **PTM-F** and **OTM-F** — see [Terminology](#terminology-ptm-f-vs-otm-f) above. The persisted shape is identical for both; the difference is in how they were discovered.
- A **FrontierCandidate** (see `src/types.ts`) is the persisted form, with a
  `status` of `'open' | 'answered' | 'blocked' | 'stale'`, a `scopeKey`
  (`computeScopeKey(rep, openingScope)`), the path of moves to reach it, and
  scoring fields (`games`, `weight`, `popularityFraction`).
- The **scopeKey** isolates frontiers by repertoire + opening folder so that
  switching folders doesn't replay another folder's frontiers. See
  `computeScopeKey` in `src/lib/autosuggest.ts`.

### Where candidates come from (`findTopUnansweredOpponentMove`)

Three phases of discovery (see comment block in `src/lib/autosuggest.ts` above
the function):

1. **Phase 1** — in-memory DFS through the user's stored edges. Walks from the
   scope's startFen downward, collecting (a) **PTM-F** ("type-1" in code: your-turn
   positions reached via stored edges that have no outgoing stored move) and
   (b) every opponent-to-move position for Phase 2 to probe.
2. **Phase 2** — parallel Lichess Explorer queries at the opponent-to-move
   positions from Phase 1. Any popular opponent move (≥ `TUNING.opponentPopularityFraction`,
   currently 0.05 / 5%) that *isn't* stored becomes an **OTM-F** ("type-2" in code);
   its `games` count is the Explorer total for the resulting childFen.
3. **Phase 3** — parallel Lichess Explorer queries at the PTM-F childFens,
   populating their `games` count (PTM-F were collected without games numbers in Phase 1
   because the DFS doesn't query Lichess; Phase 3 backfills them so PTM-F and OTM-F
   can be ranked on the same scale).

Bounds: `TUNING.maxFrontierPlies` (currently 32) caps how deep DFS will go.
`maxFrontierRebuildNodes` / `maxFrontierExplorerCalls` cap total work.

### Ranking (this is the part that has gone wrong before)

Frontiers are sorted **purely by `games`** (response volume at the frontier
position — total Lichess games recorded at that exact FEN).

```ts
// src/lib/autosuggest.ts (findTopUnansweredOpponentMove)
frontiers.sort((a, b) => b.games - a.games);
```

```ts
// src/lib/autosuggest.ts (randomizeNewCardIntroOrder)
const sorted = [...candidates].sort((a, b) => b.games - a.games);
// "top pool" = candidates within 50% of best.games; shuffled for variety.
```

```ts
// src/lib/storage.ts (sortFrontiers — retrieval order for the index)
return [...frontiers].sort((a, b) =>
  (b.games - a.games) || b.updatedAt.localeCompare(a.updatedAt)
);
```

**Why `games` and only `games`:** the user gets to a frontier because their
own prep walks to it; the relevant question for selection is "of all the
positions where my prep stops, which one are the most real opponents going to
land me in?". The answer is the position with the most Lichess games at it.
Shallow positions in popular openings have millions of games; a 25-ply-deep
specific historical continuation has near-zero. The "I have a tiny but real
chance of facing that deep position" case still resolves correctly: that
frontier has a small `games` value, and if every shallower alternative is
already answered, it will be selected. It just doesn't beat shallow alternatives
that thousands of opponents will reach you in.

**`weight` (≈ `∏ popularityFraction` along the discovery path) is kept on every
candidate for diagnostic display in the debug panel.** It is **not** used for
selection. Past bug: it was the primary sort key, but Phase 1's stored-edge DFS
(the PTM-F discovery path) did not multiply `popularityFraction` along stored-edge
paths, so deep PTM-F ended up with `weight ≈ 1.0` and beat broad shallow OTM-F
whose weight had correctly decayed during Phase 2's explorer probe. Symptom: the
user got a learn line 50 moves into a Paul Morphy game. Fix: ranked by `games`
only; weight is now display-only.
**Do not re-introduce `weight` into selection logic, including as a tiebreaker
or as part of a multiplicative score.**

### Persistence (`src/lib/storage.ts`)

The frontier index is an IndexedDB store keyed by repertoire id, with indexes
`by-repertoire` and `by-rep-status`. The full pipeline writes via
`putFrontiers(...)` (autosuggest.ts after the in-pass sort) and reads via
`getOpenFrontiers(...)` / `getFrontiersForRepertoire(...)`. State transitions:

- `markFrontierAnswered` — fired when line generation successfully adds a user
  reply at the frontier position. Same `childFen` candidates across the
  repertoire get answered together via `markFrontiersAnsweredByChildFen`.
  Also fired by `hydrateFrontierCandidate` when an open candidate is found to
  already have a stored user reply at its childFen.
- `markFrontierBlocked` — **only** fired when a candidate's path no longer
  matches the current `rep.rootFen` (stale-root case). The post-2026-05
  rewrite removed the "block on quality-gate failure" usage; that mechanism
  papered over bugs by accumulating state. Blocked candidates are kept (not
  deleted) so the debug panel can show *why* the queue is empty.
- `clearBlockedFrontiersForRepertoire(rep.id)` — auto-clean run by
  `generateLearnLine` at every entry. Sets any `'blocked'` frontiers back to
  `'open'`. Idempotent migration helper for the version transition; not
  user-callable.
- `clearFrontiersForRepertoire(rep.id, scope.key)` — purges the index for a
  specific scope; called by `rebuildFrontierQueue` for a full refresh.

### `putFrontiers` preserves any non-`'open'` existing status

When the frontier search rediscovers a frontier (same `id` =
`${repId}::${parentFen}::${uci}`), `putFrontiers` always emits new candidates
with `status: 'open'`. If the existing row's status is `'blocked'`,
`'answered'`, or `'stale'`, the existing status is preserved:

```ts
// src/lib/storage.ts (putFrontiers)
const keepExisting = existing && existing.status !== 'open';
status: keepExisting ? existing.status : frontier.status,
lastReason: keepExisting ? existing.lastReason : frontier.lastReason,
```

**Why this matters:** without the preservation, an answered frontier (already
used by a generated line) would get silently re-opened on the next rebuild,
causing the line generator to pick the same frontier again and produce a
duplicate line. The 2026-05 fix preserves all non-`'open'` statuses; only an
explicit transition (`markFrontierAnswered`, `markFrontierBlocked`,
`clearBlockedFrontiersForRepertoire`) can change a frontier's state.

### The cache (`ReadyLine`)

`src/types.ts` defines `ReadyLine`: a fully-generated line persisted in
IndexedDB for fast Train startup. The build worker (inline in `TrainMode.tsx`,
not a separate worker thread) fills the cache up to `TUNING.readyLineCap`
(currently 3) per scope while the user is actively training a scope.

- `putReadyLine` saves it. `getReadyLines` retrieves them. `deleteReadyLine`
  consumes one when the user starts a session.
- `rehydrateReadyLine(ready)` re-fetches the path edges by id and returns a
  fresh `GeneratedLine`. If any edge is missing (user deleted a subtree since
  the line was cached), it returns `null` and the caller falls through to live
  generation. **A cache hit can therefore serve a line generated under
  different tuning than what is currently active.** Hits set
  `selectionReason = 'cache-hit'`.

The cache's `scopeKey` field gates retrieval: switching opening folders
invalidates the cache for that scope but does not delete entries from other
scopes.

## User-move selection (`pickYourMove`)

The user's reply at each ply of a generated line is picked from a chain of
sources defined by `getEnabledRecommendationOrder(settings)` in
`src/lib/recommendationSettings.ts`. Common order: **player-book**
(`pickEngineSafePlayerBookMove`) → **masters** Explorer → **lichess-2000**
Explorer → **engine fallback** (local Stockfish best move at depth
`TUNING.engineDepthSelect` = 22).

**All engine evals in the line-gen pipeline go through `fetchLocalEval`,
not `fetchCloudEval`.** The Lichess cloud-eval fallback was removed in
2026-05 because the cloud endpoint ignores the `depth` argument and silently
returned depth-18 cached evals when the picker had asked for depth-22 — a
substantial difference in opening positions where engine top-1 changes
between 18 and 22 plies. `fetchLocalEval` only uses local Stockfish (served
by Vite middleware from `scripts/chesski-stockfish.cjs`); when local SF is
unreachable, it returns null and the gate's pre-flight surfaces a banner.
`fetchCloudEval` still exists for UI eval-panel callers (where depth doesn't
matter and the speed of a Lichess hit is preferable).

- Player-book sources run candidates through a five-stage pipeline (see
  **Player-book selection** below). The engine-safety stage delegates to the
  shared `judgeCandidateAtFen` helper, which is the same code path
  `evaluateUserMove` uses in the per-move quality gate. The engine eval at
  the parent FEN is shared across candidates via the `getEngine` closure
  (which calls `fetchLocalEval` lazily) to avoid duplicate Stockfish calls.
- If every configured source returns null, `pickAnyDatabaseMove` runs a
  lenient masters/lichess Explorer query with no game-count floor as a
  last-ditch attempt.
- If even that fails, `pickFirstLegalMove` picks any legal move so the line
  doesn't die mid-generation.

### Player-book selection (`pickEngineSafePlayerBookMove`)

For each player-book source the picker walks five stages and emits one
trace line per rejection. The summary line at the end of each attempt is
designed to be readable at a glance:

> `Player book Bronstein (bronstein): 4 raw moves; 0 illegal; 1 rejected by result gate; 2 rejected by engine gate; selected c3 (c2c3) expectedScoreDrop=8.0‰ lossDelta=4.0‰ cpLoss=12.`

Stages:

1. **Raw lookup** (`getPlayerBookCandidatesRaw`). Hits the player's book by
   `colorFenKey(color, fen)`. Emits `0 matching moves at normalized FEN
   <positionKey>.` and returns when the position isn't in the book.
2. **Legality.** `applyMove(fen, uciToObj(uci))` on each raw candidate.
   Should normally never reject — if it does, it's a FEN-normalization
   mismatch and worth investigating.
3. **Result gate** (`isPlayerBookCandidateTakeable`: `wins > losses`).
   Rejections list `W=… D=… L=… net=… (threshold: net>0).`
4. **WDL / cp gate** via the shared `judgeCandidateAtFen` helper. Same
   thresholds (`maxWdlExpectedScoreDrop`, `maxWdlLossDelta`,
   `maxCpLossFallbackPerMove`) as the per-move quality gate. Rejections
   list `bestWdl=W/D/L playedWdl=W/D/L expectedScoreDrop=…‰ lossDelta=…‰
   cpLoss=…` plus a `MoveClassification` (`mistake` / `blunder` /
   `mateLost`).
5. **Selection.** The surviving candidates are sorted by
   `comparePlayerBookCandidates` (net, then score-rate, then wins, etc.)
   and the first wins.

**Why the gate uses the same helper as the quality gate:** keeping picker
and gate on identical numerics means a player-book pick cannot be admitted
by the picker only to be rejected by the gate downstream. Drift between
the two used to be a recurring failure mode. See the corresponding DO NOT
bullet.

**No rollout, no multi-pass selection.** An earlier design wrapped the engine
fallback in a multi-PV + 5-move rollout simulation that ranked candidates by
their *simulated* end-position eval rather than the immediate post-move eval.
That picker was fooled by its own optimism: when an obviously losing candidate
(e.g., White ignoring a critical recapture) entered a sparse middlegame whose
Lichess Explorer continuations were thin and unrepresentative, the simulation
"saw" Black playing weakly and selected the losing candidate over the correct
recapture. Diagnosed 2026-05; replaced with single-call depth-22 best-move
pick. Don't reintroduce the rollout — if a user move feels weak, raise the
depth or improve the player-book chain instead.

Once `pickYourMove` returns a `YourMovePick` whose source is a player-book,
the line enters **`activeSourceLine` follow mode**: the player's full game
continuation drives both the user's and the opponent's subsequent moves until
either (a) the source line diverges from a legal move at the current FEN, or
(b) `yourMovesAdded >= yourMoveBudget` (`learnLineDepth`, default 5 user moves).

**`FrontierCandidate.games` plays no role in `pickYourMove`. The two
algorithms read from different stores and serve different purposes.**

## Opponent-move-in-line (`pickOpponentMoves`)

After the frontier, the opponent's reply at each ply is picked from Lichess
Explorer. Every above-`TUNING.opponentPopularityFraction` (5%) reply is added
to the repertoire **as scaffolding** so that future training has a slot to
answer it — see the loop in `generateLearnLineOnce` that calls
`playMoveInRepertoire(rep.id, cursorFen, om.san)` for each `om` in `sorted`.
Only the top-popular one is followed in the current line via `topEdge`.

If Lichess Explorer returns zero games (or fails), `opponentMovesFromStockfish`
picks an engine-derived continuation instead. This path also uses
`fetchLocalEval` (no Lichess cloud fallback); if local SF is unreachable, the
opponent picker returns an empty array and the line-extension loop
short-circuits with `terminationReason = 'no-opponent-move'`.

## Quality gate (`generateLearnLine`)

The exported wrapper `generateLearnLine` runs `generateLearnLineOnce` **once**
(`TUNING.qualityGateMaxAttempts = 1`) with a wall-clock budget of
`TUNING.qualityGateTimeoutMs` (30 minutes). The attempt is wrapped in
`snapshotGenerationState` / `restoreGenerationState` so any rejected line's
edge/frontier inserts get rolled back and don't pollute the repertoire.

### Pre-flight (every call, in order)

1. **Local Stockfish health probe.** `fetchLocalEval(STARTING_FEN_NORM, 1, 6)`
   — cheap depth-6 multi-PV eval at the starting position. If it returns null
   (local SF unreachable), abort immediately with a clear trace banner telling
   the user to start the dev server. Local SF is the only engine source for
   depth-sensitive evals (the Lichess cloud fallback was removed in 2026-05);
   if it's down, line generation fails loudly rather than silently degrading
   to depth-18 Lichess cache.
2. **Auto-clean of historical blocked frontiers.**
   `clearBlockedFrontiersForRepertoire(rep.id)` sets every frontier whose
   `status === 'blocked'` back to `'open'`. The blocked-frontier mechanism
   was removed in 2026-05; this is an idempotent one-shot migration so any
   residue from prior tuning self-heals on the next generation.
3. **Frontier preflight search** if the open set is empty for the active
   scope.

### How `evaluateLineQuality(line, color)` works (post-2026-05 rewrite)

The gate walks **each user-color edge in the generated portion of the line**
and judges each move individually. It does **not** compute a single start→end
aggregate drop anymore. Per-move semantics are more honest: a line where the
user plays five best moves but the eval drifts from `+0.7` to `-0.3` against
best play is fine (it's mainline theory under pressure), while a line with
one 1-pawn blunder is rejected even if the aggregate happens to look ok.

For each user edge:

1. **Multi-PV eval at the parent FEN** at `engineDepthGate` (22).
2. **Locate the played move's PV.** If the played UCI isn't in the multi-PV
   output (the picker can outrange the engine's top-N for popular human
   moves), do a single-PV follow-up eval at the child FEN and invert the
   result to the user's perspective (`invertWdl` for WDL; sign-flip via
   `pvCpForColor` for cp).
3. **Compute two metrics:**
   - **`expectedScoreDrop`** (per-mille) = `expectedScore(best) - expectedScore(played)`
     where `expectedScore(wdl) = wdl.win + 0.5 * wdl.draw`. Primary measure:
     how much practical chance the move costs.
   - **`lossDelta`** (per-mille) = `played.wdl.loss - best.wdl.loss`. Hard
     guard against moves that swing toward losing without much expected-score
     change.
4. **Pass condition:** `expectedScoreDrop ≤ maxWdlExpectedScoreDrop` (35)
   AND `lossDelta ≤ maxWdlLossDelta` (35). Both per-mille — 35 = 3.5
   percentage points.
5. **Cp-loss fallback** (when WDL is absent — older engine without
   `UCI_ShowWDL`, or the eval somehow came from Lichess cloud): reject iff
   per-move cp-loss exceeds `TUNING.maxCpLossFallbackPerMove` (100cp,
   Lichess "mistake" threshold).
6. **Mate-loss check:** if the best PV at the parent is a winning mate and
   the played move isn't, fail immediately ("played X but a winning mate
   (Y) was available").

The line passes iff every user move passes. **First failure short-circuits**
the walk — we don't waste evals on later moves once one has been rejected.
Inaccuracies (passing the gate but flagged) are surfaced in the trace as
informational.

### Why WDL needs the Stockfish wrapper to enable `UCI_ShowWDL`

WDL output requires `setoption name UCI_ShowWDL value true` after `uciok`.
`scripts/chesski-stockfish.cjs` sends that option; `parseInfoLine` parses
the `wdl <win> <draw> <loss>` triple. Lichess cloud-eval does not return
WDL, which is one of the reasons the cloud fallback is no longer used for
line generation. The cp-loss fallback inside the gate exists as a safety
net but should not normally fire.

### Why single-attempt

Retries within a run can't help: `pickYourMove` is deterministic per FEN, so
a second attempt would build the same line. The pre-2026-05 mechanism
worked around this by marking the rejected frontier `'blocked'` and letting
the picker try a different frontier on the next attempt, but this papered
over genuine bugs — when a frontier kept failing, blocking it just hid the
problem rather than fixing it. Now: one attempt, one verdict. If the line
fails, the user sees the failure report; the fix path is to investigate
why the picker chose a move that fails the gate, not to retry with
workarounds.

### Strict line length (`generateLearnLineOnce`)

The extension loop now tracks **why** it terminated:

- `'budget-reached'`: `yourMovesAdded === yourMoveBudget`. Success.
- `'game-over'`: `chessFromFen(cursorFen).isGameOver()` — mate, stalemate,
  threefold repetition, fifty-move rule, or insufficient material. Accepted
  even when the line is shorter than the budget; the prep ended naturally.
- `'no-user-move'` / `'no-opponent-move'` / `'top-opponent-edge-missing'`
  / `'aborted'`: the loop bailed on something the user shouldn't experience
  in a published line. These throw a `FrontierGenerationError` after the
  loop with a message like "Line generation produced 2 of 5 user moves
  (terminated: no-opponent-move). Refusing to publish a stub line." The
  wrapper rolls back snapshot state and surfaces the error.

`qualityDropCp` on the persisted `ReadyLine` is now the worst single-move
cp loss across the line (null when only WDL was measurable), rendered in
the line-queue panel as the "Drop" column.

## Scope (`computeScopeKey`, `frontierInScope`, `edgesForOpeningFolder`)

A Train session can be scoped to a curated opening folder (e.g., "Italian
Game") instead of the whole repertoire. Scope is one of the trickier parts of
the system — it has bitten several past LLM sessions — so this section is
long on purpose.

### The `FrontierScope` shape

```ts
// src/lib/autosuggest.ts
interface FrontierScope {
  key: string;                // composite identifier used everywhere
  openingKey: string | null;  // e.g., "italian-w", or null for root scope
  openingName: string | null; // e.g., "Italian Game", or null for root scope
  rootFen: NormFen;           // the repertoire's root position (always starting position for a normal rep)
  startFen: NormFen;          // where this scope's training actually starts
}
```

The crucial pair is `rootFen` vs `startFen`:

- **`rootFen`** is where the repertoire begins (effectively always the starting
  position for a top-level repertoire).
- **`startFen`** is where *the chosen opening scope ends* — i.e., the position
  the user is supposed to start training from. For the Italian Game scope it is
  the position after `1.e4 e5 2.Nf3 Nc6 3.Bc4` (FEN
  `r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq -`). For the root
  scope (no opening filter) `startFen === rootFen`.

`scope.key` is built from both:

```ts
// src/lib/autosuggest.ts (scopeFromStart / computeScopeKey)
return `${rep.color}:${openingScope.key}:${rep.rootFen}:${startFen}`;
```

The key is what gets stamped on persisted frontiers and ready-lines so two
opening folders' caches don't collide.

### What "in scope" means for a frontier — and how it goes wrong

A frontier is *in scope* iff **both** are true:

1. **Scope-key match** — `frontier.scopeKey === scope.key`. This is the cheap
   eq-check.
2. **Path-through-startFen** — `scope.startFen` appears somewhere in the chain
   from the rep root to the frontier's parent position. Concretely, either
   `frontier.parentFen === scope.startFen` *or* one of the steps in
   `frontier.path` has `toFen === scope.startFen`. When scope.startFen ===
   scope.rootFen (root scope), this condition is trivially true.

See `frontierInScope` in `src/lib/autosuggest.ts`.

**Why both checks are required:**

Frontier discovery (Phase 1 DFS) traverses the user's stored edges starting at
`rep.rootFen`, not at `scope.startFen`. Every PTM-F it encounters along the way
gets stamped with the current `scope.key` — even ones whose path stops short
of reaching `scope.startFen`. This is the "ancestor frontier" failure mode:

- Scope: Italian Game (startFen = post-3.Bc4)
- DFS hits position-after-`1.e4 e5 2.Nf3`. There are stored opp edges (Nc6,
  d6, Nf6) from here, but Phase 2's explorer probe finds *more* popular replies
  not in your prep. Those become OTM-F. They get stamped with the Italian
  scope key even though they sit one ply *before* the Italian endpoint.
- Selection later picks one of these by `games`, builds a line whose path is
  `[e4, e5, Nf3, ...something_not_Nc6]`, never passes through 3.Bc4, and the
  engine rollout picks whatever it likes (Bb5 → Ruy Lopez) instead of staying
  in Italian.

The check at line creation (`assertLineRespectsScope`) catches and rejects
these, but they cost a full generation attempt and risk burning the entire
quality-gate timeout on a doomed candidate. The path-through-startFen filter
in `frontierInScope` prevents them from being offered in the first place.

### Worked example: the Italian Game scope

Setup:

- `rep.rootFen` = starting position (`rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -`)
- `scope.startFen` = after `1.e4 e5 2.Nf3 Nc6 3.Bc4` (`r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq -`)
- `scope.key` = `w:italian-w:<rootFen>:<startFen>`

What's in scope (passes both checks):

- An OTM-F `Nf6 (g8f6)` whose `parentFen === scope.startFen` and `path = [e4, e5, Nf3, Nc6, Bc4]`. ✓ (immediate gap at the Italian endpoint)
- An OTM-F `Nxd4 (c6d4)` at some deeper position whose `path = [e4, e5, Nf3, Nc6, Bc4, Nf6, d3, h6, ..., Nxd4]`. ✓ (`scope.startFen` appears at index 4)
- A PTM-F at `r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPP2PPP/RNBQK2R w KQkq -` (after Bc4 Bc5, white to move, no stored continuation) with `path = [e4, e5, Nf3, Nc6, Bc4, Bc5]`. ✓

What's NOT in scope (the bug class):

- An OTM-F `Nc6 (b8c6)` at the position after `1.e4 e5 2.Nf3`, `path = [e4, e5, Nf3, Nc6]`. ✗ (frontier's `parentFen` ≠ scope.startFen, and no step's `toFen` matches scope.startFen — the path stops one ply short)
- An OTM-F `e5 (e7e5)` at the position after `1.e4`, `path = [e4, e5]`. ✗ (way upstream)

Even though both of those are tagged with the Italian scopeKey at discovery
time, they shouldn't be offered to the line generator when the active scope is
Italian.

### Discovery walks from `rootFen`; selection filters by `startFen`

This asymmetry is intentional but easy to forget:

- Discovery (`findTopUnansweredOpponentMove`) must start at `rep.rootFen` so
  that the path of moves it builds (and stamps onto each frontier) is the
  *full* sequence from the repertoire's true root to the gap. The frontier's
  `path` is later used to actually play the line during generation, so it has
  to include the moves needed to reach the position from the start.
- Selection (`frontierInScope` + the queue filter in `findTopFrontier`) is
  responsible for narrowing the discovered set down to the frontiers that
  actually live inside the active scope.

If you find yourself trying to make discovery scope-aware so it skips
ancestors, **don't** — you'll lose the path information needed at line-build
time. Fix it at selection time instead.

### Other uses of the scope key

`scope.key` is also used to:

- Tag persisted `FrontierCandidate.scopeKey`, so two folders' frontiers don't
  contaminate each other.
- Tag persisted `ReadyLine.scopeKey`, so the cache doesn't serve a Slav line
  when the user picked Italian.
- Filter scoped views in `TrainMode.tsx` (`scopedOpenFrontiers`,
  `scopedFrontierQueue`, `scopedEdges`). These views use the same `frontierInScope`
  helper, so the path-through-startFen invariant applies to the UI too.

`edgesForOpeningFolder(folder, edges)` (`src/lib/review.ts`) does a BFS from
the folder's `baseFen` collecting only edges inside the folder. This is the
edge filter used by the review queue when a folder is selected — separate from
the frontier index but conceptually related.

## The build worker

Lives inline in `src/modes/TrainMode.tsx` (not a separate Worker thread). It's
an async loop inside a `useEffect` that:

- Starts when `isTraining` is true and a `currentScopeKey` exists.
- Pauses when the session ends, `phase.kind` returns to `'setup'`/`'done'`,
  or the user switches folders.
- Aborts via the `workerRef.current.abort` `AbortController` on scope change.
- Fills the persistent ready-line cache up to `TUNING.readyLineCap` per scope.

It does *not* run in the background between app sessions — it's tied to the
React tree's mount, so closing the page kills it.

## TUNING knobs reference (`src/lib/autosuggest.ts` `TUNING` block)

| Knob | Current | What it controls | What goes wrong if changed badly |
| --- | --- | --- | --- |
| `evalThresholdPawn` | 0.2 | Picker's per-candidate filter slack (in pawns): `pickDatabaseMove`'s `filterByEngineEval` keeps only masters/lichess candidates within this many pawns of the engine's best. **Not used by the quality gate** (gate is now per-move WDL — see Quality gate section). | Too low → picker rejects mainline theory; too high → picker may select clearly inferior moves |
| `minGamesPerLine` | 25 | Floor on Explorer game count for a frontier to be considered | Too high → no frontiers in niche openings; too low → noise |
| `opponentPopularityFraction` | 0.05 | Threshold for treating an opponent reply as "popular" — used both to discover OTM-F in Phase 2 and to decide which opponent replies `pickOpponentMoves` scaffolds during line extension | Too high → opponents play unusual moves the user has no prep for; too low → repertoire bloats with junk |
| `yourMoveAlpha` / `yourMoveBeta` | 0.5 / 0.5 | Player-book popularity vs. win-rate weights | Skews `pickYourMove` toward popular vs. high-scoring |
| `mistakeThresholdPawn` | 1.5 | Opponent-mistake detection threshold | |
| `cloudEvalMultiPv` | 5 | Number of PVs requested per engine eval (name retained for historical reasons; local Stockfish is now the source for line-gen evals). | More = slower, more options for the picker |
| `engineDepthLineGen` | 18 | Stockfish depth during line construction for opponent-move eval and mistake-tagging (used by `pickOpponentMoves` and `opponentMovesFromStockfish`). Not used for user-move selection. | |
| `engineDepthSelect` | 22 | Stockfish depth for picking the user's move (engine fallback in `pickYourMoveDirect`'s `getEngine`). Deeper than `engineDepthLineGen` because this is a one-shot best-move pick, no rollout. | Lower → cheap user-move picks but possibly weak choices; higher → slower per-pick |
| `engineDepthGate` | 22 | Stockfish depth for the quality gate | Higher = slower but more confident verdict |
| `engineDepthDisplay` | 14 | Stockfish depth for the live eval panel | Don't raise this — UI must populate in seconds |
| `readyLineCap` | 3 | Target size for the small generated-line cache | Does **not** cap the frontier index |
| `qualityGateMaxAttempts` | 1 | **Single attempt per `generateLearnLine` call** (post-2026-05). Retries within one run can't help — picker is deterministic per FEN. | Raising this without restoring blocked-frontier plumbing would cause infinite same-line retries |
| `qualityGateTimeoutMs` | 1_800_000 | Wall-clock budget (30 minutes) per call. Generous because a 5-user-move line needs ~10-15 serial depth-22 SF evals. | Lowering will time out legitimate slow generations on cold positions |
| `maxWdlExpectedScoreDrop` | 35 | Per-move WDL gate: max expected-score drop in per-mille (35 = 3.5 percentage points). Primary gate metric. | Too strict → mainline theory rejected; too loose → bad lines pass. Presets: strict 20–25, balanced 35, faithful 50, loose 75 |
| `maxWdlLossDelta` | 35 | Per-move WDL gate: max loss-probability increase in per-mille. Hard guard for winning→drawing swings. | Same flavor as expected-score drop |
| `maxCpLossFallbackPerMove` | 100 | Fallback per-move cp-loss threshold used only when WDL is unavailable (older engine, Lichess cloud). 100cp = Lichess "mistake". | Should rarely fire if local SF is running with `UCI_ShowWDL` enabled |
| `maxFrontierPlies` | 32 | Hard cap on DFS depth when discovering frontiers | Sanity bound; do not rely on this for ranking |
| `frontierQueueTarget` | 3 | Legacy name retained in code for compatibility | Do not use this to stop frontier-index discovery |
| `maxFrontierRebuildNodes` | 180 | Max DFS nodes during full rebuild | |
| `maxFrontierFallbackNodes` | 32 | Max DFS nodes during fallback search | |
| `maxFrontierExplorerCalls` | 60 | Cap on parallel Explorer calls during rebuild | |
| `maxFrontierFallbackExplorerCalls` | 10 | Cap on parallel Explorer calls during fallback | |
| `prepMinGamesPerBranch` | 100 | Map-my-prep: min games for a branch to be worth showing | |
| `prepOpponentPopularityFraction` | 0.08 | Map-my-prep: opponent popularity threshold (stricter than line-gen) | |
| `prepMaxOpponentBranches` | 5 | Map-my-prep: max branches per node | |

## Eval display in the walkthrough

`LineEvalPanel` (in `TrainMode.tsx`) is **always white-positive**: + = good
for White, − = good for Black, regardless of the repertoire's color. The
evaluated FEN is shown beneath each value so any FEN/board mismatch is visible
without needing dev tools. Internal mistake-detection elsewhere
(`evaluateMoveCpLoss`) still uses side-of-color sign; only this panel display
is white-positive.

Stale values are tracked explicitly: each fetched eval records the FEN it
was for, and if the prop FEN differs (i.e. the cursor advanced before the
eval returned), the panel falls back to `'...'` rather than showing a value
for a different position.

## Failure traceability

Two copyable reports exist for chasing bugs:

1. **Failure report** (`buildFailureReport` in `TrainMode.tsx`) — rendered
   inline beneath the red error banner whenever `setGenError(...)` fires.
   Includes: repertoire id/name/color/rootFen, opening folder (or "entire
   repertoire"), `currentScopeKey`, scoped edge count, frontier queue
   counts by status, ready-line cache size, worker status, abort
   controller presence, the top scoped open frontiers (up to 10), and the
   full `genTrace`.
2. **Line report** (`SelectionDetailsPanel` in `TrainMode.tsx`) — rendered
   in the walkthrough when "Show debug info" is on. Includes everything
   the failure report has plus: the line's `selectionReason`,
   `frontierId`/`frontierFen`, line structure (plies/start index), cursor
   info, source game, the evaluated FENs, and scope-match status.

Both reports are designed to be self-contained — paste one into ChatGPT/Codex
and it should be enough to diagnose without re-running anything.

## Diagnosing a failure report

When the user pastes a failure report, walk it top-to-bottom in this order:

1. **Final reason line** — gives the user-visible verdict (Stockfish-down vs
   failed quality gate vs no-user-move vs frontier-exhaustion). Map this to
   which stage failed:
   - `Local Stockfish unreachable at /api/stockfish/eval` → the pre-flight
     health probe at the top of `generateLearnLine` failed. The dev server
     isn't running, OR `chesski-stockfish.cjs` is crashing. Verify Vite is
     up and the Stockfish exe path resolves.
   - "1 candidate line failed the quality gate" → a line was produced but
     `evaluateLineQuality` returned FAIL *or* `assertLineRespectsScope`
     rejected it post-hoc. Look for `Quality gate: FAIL` or `!!! SCOPE LEAK !!!`
     in the trace.
   - "generation timed out or was aborted before a usable line passed" →
     no candidate completed inside the 30-minute budget. Almost always means
     Stockfish is wedged or evaluating absurdly slowly. Look at the
     timestamps on `Your move picker: requesting engine eval at depth 22`
     entries — each one should resolve in seconds.
   - "no open frontier candidates remained" → the frontier index is empty
     for this scope. Look at the `Top scoped open frontiers` block — if it's
     empty, the rebuild is the suspect.
   - "Line generation produced N of M user moves (terminated: …). Refusing
     to publish a stub line." → the extension loop bailed early on
     something that wasn't game-over. The `terminated:` tag tells you which
     break site fired (`no-opponent-move` / `no-user-move` /
     `top-opponent-edge-missing` / `aborted`). See "Strict line length" in
     the Quality gate section.

2. **Counts block** — `openFrontiers=N (M in current scope)`. If `M` is small
   or zero while there are stored edges, scope filtering is rejecting too
   much. If `M` is plausibly large but `attemptedCandidates=1` followed by a
   failure, the *first* candidate is the problem, not the index.

3. **Top scoped open frontiers** list — sanity-check that the listed
   childFens actually correspond to positions inside the scope's opening.
   For Italian Game, every childFen should be reachable from the post-3.Bc4
   position. If you see `childFen` strings that decode to positions *before*
   the scope endpoint, you're looking at an ancestor-frontier leak —
   `frontierInScope` is the place to fix.

4. **Trace events**, in order:

   a. **`Cleared N stale blocked frontiers from prior runs.`** (if present)
   — the auto-clean migration ran. Expected exactly once per repertoire
   that still has residue from the pre-2026-05 blocked-frontier mechanism.
   If you see this every call, something is still calling `markFrontierBlocked`
   for non-stale-root reasons — find and fix that path.

   b. **`Frontier index stats`** — sanity-check `open=N` vs the count of
   in-scope frontiers shown in the report.

   c. **`Line source: frontier-index; selected …`** — what frontier was
   picked. Decode the `childFen` and check whether that position is
   plausibly inside the scope. If not, you have an ancestor leak.

   d. **`Frontier index: filtered N ancestor candidate(s)`** (if present) —
   tells you the path-through-startFen filter rejected some candidates. If
   you also see `selected … because it is an open candidate in the top games
   pool`, the filter saved you from a bad pick. If this line is missing and
   you got a scope leak, the filter isn't engaging — check that
   `frontier.path` is being populated correctly at discovery time.

   e. **`Line generation: path uses stored edge …`** — the sequence of
   stored edges that lead to the frontier's `childFen`. Confirm it matches
   the scope's prescribed path for the first N plies.

   f. **`Your move picker: requesting engine eval at depth 22, fen=…`** then
   **`Your move picker: engine returned N PVs at depth 22.`** — the picker's
   engine fallback. One pair per user-move pick where the player-book chain
   didn't fire. If you see `Your move picker: local Stockfish unavailable`
   anywhere, the dev server is down — the gate's pre-flight probe should
   have caught this earlier, so seeing it mid-line means SF died after the
   probe. If you see `(requested 22, undershot by N)`, the wrapper's depth
   cap is mis-configured (`chesski-stockfish.cjs:requestedDepth` should be
   `Math.min(..., 30)`).

   g. **`Opponent move picker: accepted Explorer move …`** — sanity-check
   that `pickOpponentMoves` saw reasonable popular replies. Mostly diagnostic.

   h. **`Line generation: success. fullPath=N, newEdges=M`** — the line was
   built. If `M > 0` and you later see `rolled back; deletedEdges=M`,
   those scaffolded edges were rolled back along with the rejected line.

   i. **`Quality gate: walking N user moves at depth 22.`** then per-move
   verdict trace lines:
   - `Quality gate: move K (san) → Played san: expectedDrop=X.X (max 35),
     lossDelta=Y.Y (max 35) cpLoss=Z — classification.`
   - WDL values are per-mille (0–1000). `expectedDrop=42.0` means the move
     costs 4.2 percentage points of expected score — over the 35 threshold,
     fails as a mistake. `cpLoss` is informational when WDL is the gate.
   - Classifications: `best` (≤10 / negligible), `good` (within threshold),
     `inaccuracy` (passes but flagged), `mistake` (fails), `blunder` (fails
     by big margin), `mateLost` (winning mate played as non-mate).
   - **A `FAIL` with `expectedDrop` just barely over 35 suggests the gate is
     doing its job; loosening the threshold is rarely the right fix.** Look
     at the picker's choice for that ply — engine top-1 might disagree with
     the masters explorer's popular move; the picker filter
     (`evalThresholdPawn = 0.2`) may have admitted a borderline candidate
     that the gate then rejects at depth 22. If WDL is available the gate
     uses it; if you see `cpLoss=… (no WDL)` then `UCI_ShowWDL` isn't being
     set — fix `chesski-stockfish.cjs`.

   j. **`Quality gate: rolled back; deletedEdges=N, restoredEdges=M`** —
   confirms the rejected line's edges/frontier-state changes were undone.
   `restoredEdges` should equal `storedEdges` before the attempt.

5. **Background frontier refill log** (the `frontier background:` lines at
   the very bottom) — this is the rebuild that runs *after* the failure,
   filling the index back up. It's mostly noise during diagnosis, but if the
   rebuild reports `Frontier opponent moves: Explorer failed` repeatedly,
   Lichess is rate-limiting or down. Also: if you see a rebuild
   immediately followed by the SAME frontier being picked again on the next
   user generation, suspect a `putFrontiers` regression — the post-2026-05
   fix preserves any non-`'open'` existing status; if that guard is broken,
   the rebuild silently re-opens answered frontiers and you'll see duplicate
   lines.

## Common bug patterns

A non-exhaustive map of symptoms → likely cause → where to look:

| Symptom in failure report | Likely cause | Where to look |
| --- | --- | --- |
| `Local Stockfish unreachable at /api/stockfish/eval` banner | Dev server not running, or `chesski-stockfish.cjs` crashing | Restart Vite (`npm run dev`); confirm the Stockfish exe exists at the path `scripts/chesski-stockfish.cjs` resolves; `chesski-stockfish.cjs` is loaded once at Vite startup so a code change there needs a server restart |
| `(requested 22, undershot by 4)` in picker traces | Wrapper depth cap is too low | `chesski-stockfish.cjs:requestedDepth` should be `Math.min(..., 30)`; older versions capped at 18. Restart Vite after the fix |
| `cpLoss=… (no WDL)` in gate traces | `UCI_ShowWDL` not enabled in the SF wrapper | `chesski-stockfish.cjs` should send `setoption name UCI_ShowWDL value true` after `uciok`; `parseInfoLine` should parse the `wdl <win> <draw> <loss>` triple |
| `SCOPE LEAK` after a successful quality gate | Ancestor frontier (path doesn't pass through scope.startFen) was selected | `frontierInScope` — confirm the path-through-startFen check is engaging; check `Frontier index: filtered N ancestor candidate(s)` is present |
| `Quality gate: FAIL — Played X: expectedDrop=N.N > 35` just over threshold | Genuine quality issue, not necessarily a bug | Don't loosen `maxWdlExpectedScoreDrop`; inspect the engine's multi-PV at the offending parent FEN to see whether the picker's chosen move is genuinely worse than the engine's top, or whether the picker filter (`evalThresholdPawn`) is too permissive |
| `Quality gate: FAIL — Played X: lossDelta=N.N > 35` with small expected drop | Move trades winning chances for drawing chances without much expected-score change | This is what the loss-delta guard exists for; trust it. Investigate whether the line is in a position where the user has multiple roughly-equal continuations and the picker chose the most loss-prone one |
| Same line generated twice in a row | `putFrontiers` regression — non-`'open'` existing statuses not preserved on rebuild | `storage.ts:putFrontiers` — the `keepExisting = existing && existing.status !== 'open'` guard must hold; if it's broken, answered frontiers get silently re-opened |
| `Line generation produced 2 of 5 user moves (terminated: …)` | Picker hit a dead end (no popular opponent reply, etc.); strict-length gate rejected the stub line | The `terminated:` tag tells you which break site. `no-opponent-move` is the most common — the position had no >5%-popular Lichess response. Check whether the frontier is deep enough that opponent play is sparse, and consider whether `pickOpponentMoves` should fall back to Stockfish-derived continuations more aggressively |
| `openFrontiers=0` for the active scope | Index never populated, or rebuild was aborted before producing any | Check the frontier refill log at the bottom; verify scope.startFen is a legal position |
| Line generated outside the chosen opening despite scope filter | Engine picker doesn't know the scope's prescribed moves | The `frontierInScope` filter prevents this when the chosen frontier is upstream; for frontiers *inside* the scope it's still possible if the engine picks a non-scope-conforming continuation (e.g., Bb5 after Italian setup). Consider adding scope-path-aware constraints to the engine fallback in `pickYourMoveDirect`. |

## DO NOT — past failure modes

- **Do not sort frontiers by `weight × games` or any combined score.**
  Tried it, overcomplicated. `weight` is bogus for stored-edge frontiers.
  Ranking by `games` alone matches the user's mental model and works.
- **Do not re-introduce `weight` as a tiebreaker** in any of the three
  frontier sort sites (`findTopUnansweredOpponentMove`,
  `randomizeNewCardIntroOrder`, `storage.ts:sortFrontiers`).
- **Do not add a synthetic depth cap** on total line length
  (`maxLineTotalPlies` or similar). `maxFrontierPlies = 32` is a sanity
  bound on DFS; `learnLineDepth` (default 5) caps user moves in extension.
  Together they're enough — depth caps would mask underlying ranking bugs.
- **Do not use `games` in `pickYourMove`** or any other user-move selection.
  It is a frontier-selection metric only.
- **Do not let line extension follow a source game past `learnLineDepth`
  user moves.** The loop in `generateLearnLineOnce` correctly increments
  `yourMovesAdded` per user move and stops at `yourMoveBudget`. Don't
  "fix" this loop to count plies instead.
- **Do not add recursive DFS in `src/lib/viewLines.ts`.** Cyclic repertoire
  data infinite-loops. The current code uses an iterative stack with
  per-path seen-FEN tracking and a path-length absurdity cap; keep it.
- **Do not flip eval sign in `LineEvalPanel`.** The panel is white-positive
  by design (matches Lichess / engine convention). If you find yourself
  reaching for `pvCpForColor` to "fix the sign", you've misread the panel.
- **Do not delete the `Copy failure report` / `Copy line report` buttons**
  even if they look redundant with the `Show debug info` panels. They are
  the user's primary handoff path to ChatGPT for diagnosing weird picks;
  the panels are too easy to miss.
- **Do not make frontier discovery scope-aware** (i.e., do not start DFS at
  `scope.startFen` instead of `rep.rootFen`). The `frontier.path` field needs
  to be the full sequence from the repertoire root to the gap, because the
  generator uses it to actually play the line at build time. Filter at
  selection time via `frontierInScope`, not at discovery.
- **Do not weaken `frontierInScope` back to a pure scopeKey check.** Past
  ancestor-leak bugs would re-surface. The path-through-startFen check is
  load-bearing; if you find yourself removing it because some legitimate
  frontier got filtered, the bug is in how `frontier.path` is being populated
  at discovery time, not in `frontierInScope`.
- **Do not reintroduce the engine rollout picker.** In 2026-05 the user-move
  picker briefly used multi-PV + 5-move rollout simulation that ranked
  candidates by their *simulated* end-position eval. It got fooled by its own
  optimism — selected Be3 (loses a piece) over Qxd4 (correct recapture)
  because the simulated Black replies after Be3 were unrealistically weak.
  Replaced with single-call depth-22 best-move pick. If user moves feel weak,
  raise `engineDepthSelect` further or improve the player-book chain. Do not
  bring back any "look ahead and simulate to evaluate" picker — it's the same
  bug class with a different name.
- **Do not investigate "the engine picked a non-scope-conforming move" by
  making the engine picker scope-aware before checking whether the picker
  was even *called from* an in-scope position.** The scope leak in 2026-05
  was first diagnosed as "the engine picked Bb5 over Bc4 outside Italian
  scope"; tempting fix was to make the engine fallback scope-aware. The real
  fix was upstream — the picker was at a position upstream of Italian because
  the frontier filter let an ancestor through. Always check `frontierInScope`
  first.
- **Do not silently fall back to Lichess cloud-eval for line-generation
  evals.** The cloud endpoint ignores the `depth` argument; calls asking for
  depth-22 silently received depth-18 cached results. All line-gen evals
  (`pickYourMoveDirect` engine fallback, `pickOpponentMoves` engine path,
  `evaluateLineQuality`, `evaluateMoveCpLoss`, `measureCpLoss`) must use
  `fetchLocalEval`, not `fetchCloudEval`. UI eval-panel callers (Browse,
  TrainMode live-eval) may still use `fetchCloudEval` — they don't care
  about precise depth.
- **Do not negative-cache local Stockfish lookup failures.** Pre-2026-05,
  `fetchLocalStockfishEval` wrote `localEvalCache.set(cacheKey, null)` on
  every error path. One transient timeout permanently poisoned that
  (FEN, multiPv, depth) tuple for the rest of the page session, causing
  downstream null-results that truncated lines mid-generation. Cache only
  successes.
- **Do not reintroduce the blocked-frontier-on-gate-failure mechanism.**
  Pre-2026-05, `generateLearnLine` would mark the rejected frontier
  `'blocked'` and retry up to `qualityGateMaxAttempts` times with different
  frontiers. The picker is deterministic per-FEN, so retries within a run
  built the same line for the same frontier; the only retry signal was
  "block this and try a different frontier", which accumulated state and
  papered over real bugs. The post-2026-05 design is **single-attempt**:
  one line, one verdict, fail loudly. `markFrontierBlocked` is reserved
  for the stale-root case only.
- **Do not break `putFrontiers`'s non-`'open'` status preservation.** When
  the frontier search rediscovers an existing frontier, it always emits
  `status: 'open'`. The guard
  `keepExisting = existing && existing.status !== 'open'` preserves the
  existing status when it's `'blocked'`, `'answered'`, or `'stale'`.
  Removing or weakening this guard re-introduces the 2026-05-18 duplicate-
  lines bug: answered frontiers silently get re-opened on every rebuild,
  causing the line generator to pick the same frontier again.
- **Do not reintroduce `playerBookMaxCpLoss` or any source-local engine
  threshold.** The player-book gate must use the same WDL/cp-fallback
  thresholds as the per-move quality gate via the shared
  `judgeCandidateAtFen` helper so picker decisions can never disagree with
  gate verdicts. The pre-2026-05 `playerBookMaxCpLoss` setting was deleted
  for this reason; a future user-configurable quality preset (see
  `docs/wishlist.md`) must apply to both picker and gate via the same
  helper.
- **Do not gate-only on cp-loss when WDL is available.** Centipawn loss is
  noisy in opening positions where eval swings between +0.7 and -0.3
  mean the same draw rate. WDL's expected-score drop captures practical
  game-result effect; the cp-loss path inside `evaluateLineQuality` is a
  fallback for the case where WDL isn't reported (older engines, Lichess
  cloud paths). The `cpLoss` field is still computed and displayed for
  diagnostic value but is not the primary gate.
- **Do not publish short lines except for game-over.** The
  `terminationReason` tracking in `generateLearnLineOnce` exists so that
  the only acceptable short-line termination is mate / stalemate /
  threefold / fifty-move / insufficient material. Any other early exit
  (no opponent reply above threshold, etc.) throws a
  `FrontierGenerationError` and rolls back. Don't add an "accept short
  lines anyway" escape hatch — stub prep is worse than no prep.
