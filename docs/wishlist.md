# Chesski wishlist

Major outstanding work, in rough priority order. Each item is a real design
question, not a one-line tweak. Skim before starting a session that's adjacent
to one of these — surprise overlap is the most common cause of regressions.

---

## Chessable-style SRS review rework

**Status:** Designed but not yet implemented. See the matching plan in
`~/.claude/plans/` when active. **Priority: high** — this is the next major
piece of training UX work after the line-selection ranking fix.

### Why this matters

Chesski's current review system treats due cards too individually. Opening
memorization works better when the user is placed inside a real line context —
played up to the due move, prompted, and then carried forward through any
adjacent due moves in the same line. Reviewing each due position as a
standalone "puzzle" with no shared context makes the user re-learn the same
opening over and over because every session looks unfamiliar, and it
disproportionately drills the first few moves (which are due constantly
because they're the prefix of everything).

### What we want

The SRS *unit of state* remains an individual edge/position: "given this
position, play the correct move." That doesn't change. What changes is the
**review delivery layer**: review sessions should be served line-by-line and
branch-by-branch, not card-by-card.

Concrete example. User is studying the Evans Gambit inside Italian:

```
1.e4 e5  2.Nf3 Nc6  3.Bc4 Bc5  4.b4 Bxb4  5.c3 Ba5  6.d4
```

If the user has mastered the b4 reply to ...Bc5 and the c3 reply to ...Bxb4,
but the d4 reply to ...Ba5 is due today, then:

- The app plays through moves 1-5 automatically as **context**.
- The app prompts the user for **d4** (the due card).
- If the next move in this line (e.g., 6...exd4) and the user's reply (e.g.,
  7.O-O) are also due, they're prompted inline without resetting to the root.
- Only the prompted moves get SRS updates. Auto-played context moves do not.

### Tree-style review traversal

Because lines share prefixes, the order of branches matters. Random card order
forces context resets; coherent branch order lets the user flow:

1. Collect all due cards in the selected scope (repertoire or opening folder).
2. Map each due card to its path from the scope's root.
3. Group cards by shared ancestry — find the deepest branch points that
   cluster multiple due cards.
4. Review the deepest-shared branch first as a coherent line:
   - Auto-play non-due context moves.
   - Prompt due moves in sequence.
   - Continue until all due cards in that branch are handled.
5. Move to the next nearest branch point. Don't jump back to the root unless
   the next due card legitimately requires a different opening.
6. Gradually peel upward/outward through the tree.
7. Finish one major opening family before moving to the next.

For the Italian: review all due Giuoco Piano lines first (working from
deepest clusters backward), then Knight Attack lines, then Evans Gambit
lines, etc. — the user should feel like they're working through coherent
opening families, not random positions.

### What this is NOT

- **Not** a change to SRS state. Per-edge `ease` / `intervalDays` / `reps` /
  `lapses` / `dueAt` stay exactly as they are. No schema migration of edges.
- **Not** a change to the Learn pipeline. Frontier selection, line generation,
  the ready-line cache, and the build worker stay untouched.
- **Not** "review whole lines as a single unit." A line is a *delivery
  vehicle*; the SRS unit is still the individual edge.

### Implementation considerations

When this is picked up, the design plan must address:

- **Current architecture inventory**: where edge SRS state lives, how
  `buildReviewQueue` / `getEdgesByMover` / `isDue` produce the current
  flat queue, and where TrainMode consumes it (`enterReviewPhase`).
- **New derived structures**: a per-session "review plan" or "review
  segments" type that groups due cards by branch. Derived only, never
  persisted — recompute at session start.
- **Tree grouping algorithm**: build paths from scope root to each due
  card, find lowest common ancestors, order branches by "deepest shared
  branch first" then by due-card count.
- **Auto-play UI**: a short animation/flash for context moves, a clear
  visual cue when the prompt arrives. Reuse the existing walkthrough
  animation machinery if possible.
- **SRS isolation**: gradeFail / gradePass / gradeLearnPass must fire
  ONLY for prompted moves. Context moves never touch SRS state.
- **Opening folder scope**: respect `edgesForOpeningFolder` exactly as
  the current review queue does. The grouping algorithm runs on the
  scoped edge set, not the whole repertoire.
- **Performance**: build the day's review plan once per session start;
  cache root-to-card paths during construction; don't re-scan the tree
  on every prompt. Target: stays responsive on the 2000-edge Italian.
- **Migration**: zero schema changes. The review plan is derived. If
  the new code path has bugs, the existing flat review queue is the
  fallback.
- **Interactions to watch**: pre-generated line queue (Phase 2 of
  line-selection — should not conflict because that's Learn-only), the
  planned "flow state" feature (review continuity should help, not
  hurt), imported-PGN review (must still work).

### Done criteria

- Reviewing a scoped opening with N due cards completes in roughly N
  prompts, not N+(context overhead) prompts. Auto-played context is
  visible but not counted.
- Two adjacent due cards in the same line are prompted back-to-back
  without a reset to the root.
- A failed prompt re-queues that card the way the current flat queue
  does, without disrupting the surrounding branch.
- Review for a 2000-edge repertoire builds in under a second and
  prompts feel instantaneous between cards.
- `npm run build` clean. `npm test` clean. Add unit tests for the
  grouping algorithm in `src/lib/review.test.ts` (new file).

---

## User-configurable per-move quality gate

**Status:** Wishlist. No code, no schema. **Priority: medium** — the
groundwork is in place (single chokepoint for the gate math); blocked on
designing the settings surface and migration story.

### Why this matters

The per-move quality gate currently runs with fixed TUNING thresholds
(`maxWdlExpectedScoreDrop = 35`, `maxWdlLossDelta = 35`,
`maxCpLossFallbackPerMove = 100`). Different players want different
risk profiles: an aggressive player wants the gate to forgive
loss-probability drift if winning chances are preserved; a cautious
player wants exactly the opposite. The line-selection doc already
names presets — *strict* 20–25, *balanced* 35, *faithful* 50, *loose*
75 — but they aren't user-selectable yet.

### What we want

Two related capabilities the settings surface should expose:

1. **Threshold tuning.** Let the user pick a preset (or set a custom
   value) for the existing `expectedScoreDrop` / `lossDelta` caps. The
   chosen values must flow into BOTH the per-move quality gate AND the
   player-book / database pickers, via the shared
   `judgeCandidateAtFen` helper in `src/lib/autosuggest.ts`. The
   picker and gate must stay symmetric — that is the load-bearing
   property of the post-2026-05 refactor and the reason
   `playerBookMaxCpLoss` was deleted.

2. **Per-component (W/D/L) gate algorithm.** The current gate combines
   two derived metrics (`expectedScoreDrop = ΔW + 0.5·ΔD`, `lossDelta = ΔL`).
   A future iteration should let the user shape the gate over the raw
   W/D/L deltas directly — separate caps on `ΔW` (acceptable
   win-probability drop), `ΔD` (acceptable draw-probability shift),
   `ΔL` (acceptable loss-probability rise) — and choose a weighting
   profile mapped to player risk style:
   - *Aggressive*: tight cap on `ΔW`, generous on `ΔL` — accepts
     losing-prob increases as long as winning chances are preserved.
   - *Cautious*: tight cap on `ΔL`, generous on `ΔW` — accepts giving
     up winning chances if it prevents loss-prob rises.
   - *Balanced*: middle-ground caps on all three, with a weighted-sum
     score.
   - *Custom*: numeric controls on each cap so power users can dial
     in their own profile.

### Implementation notes

- **Single chokepoint.** `judgeCandidateAtFen` (`src/lib/autosuggest.ts`)
  is the only place that decides `passed` for a candidate. Replace its
  fixed-threshold `passed = …` block with a pluggable scorer
  parameterized by the user's profile. `evaluateUserMove` and
  `pickEngineSafePlayerBookMove` both call this helper, so both
  inherit the new behavior automatically.
- **Settings shape.** Likely a new `qualityProfile` field in
  `RecommendationSettings` (or a sibling). Schema migration: default
  the profile to "balanced 35/35" so existing repertoires behave
  identically.
- **Don't reintroduce source-local thresholds.** The DO NOT bullet in
  `docs/line-selection.md` is load-bearing — the same threshold must
  apply to picker and gate within one repertoire/opening scope.

### Done criteria

- User can switch quality profile from a settings panel; the change
  takes effect on the next `generateLearnLine` call.
- Same profile is consulted by `pickEngineSafePlayerBookMove` (picker)
  and `evaluateUserMove` (gate); changing the profile changes both at
  once.
- A line built and accepted under a strict profile is rejected when
  the gate is re-run under a stricter profile (sanity test).
- `npm test` clean with new unit tests around the pluggable scorer.
- Migration path verified: old repertoires/settings default to
  balanced and produce no change in behaviour.

---

## Leech detection and the "Leeches" folder

**Status:** Not started. **Priority: medium** — depends on the segment-loop
review work landing first (which it has, 2026-05-21). Surfaced when the user
asked for a way to handle cards they keep getting wrong without manual
intervention.

### Why this matters

Some cards keep failing across sessions. Right now the SRS algorithm just
keeps shortening the interval (ease drops to the 1.3 floor, then `round(d *
1.3)` grows the interval slowly). The user has no way to see which cards are
the persistent problem children — and no UI to decide "actually, the
repertoire move here is wrong for me; pick a different one."

### What we want

- **Detection.** After each review session, for every edge that was in the
  session's `failedPromptIdsThisSession`: increment a per-edge
  `consecutiveFailedSessions` counter (new field on `Edge`, default 0). For
  every edge that was passed cleanly this session (in `gradedPromptEdgeIds`
  with no later fail): reset the counter to 0. When the counter hits 5,
  mark the edge as a leech.

- **Surface.** Add an inconspicuous "Leeches" folder to the Repertoire tab.
  It lists every edge currently flagged as a leech, grouped by opening.
  Click into one to see the position, the stored move, and two buttons:
  **Keep** and **Change**.

- **Keep.** Clears the leech flag and resets `consecutiveFailedSessions` to
  0. The card resumes normal SRS scheduling. No move change.

- **Change.** Runs the user's per-opening algorithm (player-book → masters
  → lichess-2000 → engine, per `recommendationSettings`) using the existing
  `pickYourMove` machinery to recommend the **next-best alternative move at
  this position**. Critically the recommender must EXCLUDE the current
  stored move so it picks something different. User confirms; the edge gets
  swapped via `swapMoveInRepertoire` (same mechanism the override flow
  uses), the leech flag clears, and `consecutiveFailedSessions` resets.

### Open questions

- Where does `consecutiveFailedSessions` live? On the `Edge` itself or in a
  separate `leechState` store? Adding a field to `Edge` is simpler but
  every edge then carries it; a separate store keeps `Edge` lean.
- Threshold tunable per user (Settings → SRS system settings)? Default 5.
- What about scaffolding edges (opponent moves)? They're never graded so
  they can never become leeches — confirm `consecutiveFailedSessions`
  stays at 0 for them.
- Does session-end leech increment count when a card was failed THEN passed
  in the same session? Per the same-session-grade rules, "passed after
  fail" still ends in fail state, so yes — increment.

### Done criteria

- New `consecutiveFailedSessions` field present on every edge with sensible
  default + migration path.
- Increment/reset logic runs at session end (somewhere in
  `enterReviewPhase`'s tear-down or a dedicated `finishReviewSession`
  function).
- Leech threshold const lives next to other tuning constants in TrainMode
  or in `trainingPreferences`.
- "Leeches" folder appears in the Repertoire tab when at least one leech
  exists; hidden otherwise.
- Per-card Keep / Change buttons functional; Change uses `pickYourMove`
  with the current stored move excluded.
- `npm test` clean; new unit tests for the increment/reset logic and the
  "exclude stored move" recommender variant.

---
