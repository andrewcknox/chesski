# Review flow — how line-aware (Chessable-style) review works

**Audience: future Claude (and human) sessions inheriting this codebase.**
Companion to `docs/line-selection.md` (which covers Learn). Read this before
touching `src/modes/TrainMode.tsx`'s review render, `src/lib/reviewPlan.ts`,
`src/lib/srs.ts`, or `src/lib/review.ts` — the system has two delivery modes
that share a Phase kind, and conflating them is easy.

## The two-layer distinction — do not conflate

Review has two completely separate layers:

| Layer | What it is | Lives in | Touched when… |
| --- | --- | --- | --- |
| **SRS state** | Per-edge fields: `ease`, `intervalDays`, `reps`, `lapses`, `dueAt`, `lastReviewedAt`. SM-2 grading mutates them. | `src/types.ts` (Edge), `src/lib/srs.ts` (`isDue` / `gradePass` / `gradeFail` / `gradeLearnPass`) | A card is graded — never during context auto-play |
| **Review delivery** | How due cards are presented: flat one-card-at-a-time, OR line-by-line with auto-played context. | `src/modes/TrainMode.tsx` (the `phase.kind === 'review'` render branches), `src/lib/reviewPlan.ts` (segment planner) | A session starts and a plan is built |

The Chessable rework changed **delivery only**. SRS state, the grading
functions, due-date logic, and the IndexedDB edge schema are untouched. If a
future change feels like it's about "review", first ask whether it belongs in
the SRS layer or the delivery layer — the answer dictates which files you
touch.

## Two delivery modes share one Phase kind

`Phase = { kind: 'review', queue, idx, mode, sub, …, plan?, segmentIdx?, contextPlyIdx?, promptIdxInSegment? }`

- **Legacy (flat) mode** — `plan` is `undefined`. The renderer falls into the
  one-card-at-a-time UI. `queue`/`idx` drive it.
  `attemptReviewMove` / `advanceReviewAfterFlash` / `returnReviewToAwait` /
  `handleSkipReview`.
- **Segmented (line-aware) mode** — `plan` is present. The renderer enters
  the segmented branch. `segmentIdx`/`contextPlyIdx`/`promptIdxInSegment`
  drive it. `queue`/`idx` are inert (kept for backward compatibility but the
  segmented controller ignores them).
  `attemptSegmentedReviewMove` / `advanceSegmentedReviewContext` /
  `advanceReviewSegmentAfterFlash` / `jumpToNextSegment` /
  `handleSkipSegmentedReview`.

Both modes exist in the codebase intentionally. The legacy mode is the
runtime fallback when planning fails *and* the opt-out when
`trainingPreferences.useLineAwareReview` is off. **Do not delete the legacy
path.**

## Planner — `src/lib/reviewPlan.ts`

The planner is pure data and read-only over edges. It takes:

- `dueCardsInDueOrder: Edge[]` — already produced by the existing
  `buildReviewQueue(scopedEdges, …)` in `src/lib/review.ts`. Mover-filtered,
  sorted by dueAt asc, capped at `reviewSessionLength`. **Don't change
  `buildReviewQueue`.** The planner consumes its output verbatim.
- `scopedEdges: Edge[]` — the full edge graph used for path traversal. When
  scoped to an opening folder, this is `edgesForOpeningFolder(folder,
  allRepEdges, allRepEdges)` — using `allRepEdges` for both arguments lets
  the BFS step through opponent scaffold edges to reach user-mover positions.
- `scopeRootFen: NormFen` — `scopedFolder.baseFen` (folder-scoped) or
  `repertoire.rootFen` (whole-repertoire).

It produces a `ReviewPlan`:

```ts
interface ReviewPlan {
  segments: ReviewSegment[];   // emitted in the order each first opened
  totalPrompts: number;
  totalContextPlies: number;
  droppedCards: string[];      // edge ids the planner couldn't path
  trace: string[];             // diagnostic, used by the failure-report banner
}

interface ReviewSegment {
  segmentId: string;
  rootFen: NormFen;            // = path[0].parentFen (board starts here)
  path: Edge[];                // linear root → end walk
  prompts: ReviewPrompt[];     // pathIdx asc; due cards are prompted here
}
```

### The algorithm (collinearity, dueAt-preserving)

For each due card in dueAt order:

1. BFS from `scopeRootFen` across the parent→children index (built once via
   `buildPathIndex(scopedEdges)`) to find the path of edges leading to this
   card. Cycle-safe (visited-FEN set). If unreachable, the card is dropped
   into `plan.droppedCards`.
2. Look for an existing segment whose path is **collinear** with this card's
   path — i.e., one path is a prefix of the other. If found, merge: extend
   the segment's path if the new card is deeper, and add a new prompt at the
   card's pathIdx.
3. Otherwise, open a new segment.

Segments emit in the order they were opened. That order is dueAt-asc of the
first card in each segment — the user's SRS priority signal is preserved.
**There is no second-stage sort by prompt count / depth / lex.** The user
explicitly chose dueAt preservation over "deepest-branch-first" coherence.

### Worked example (the Italian/Evans Gambit case)

Suppose due cards are (in dueAt order):

1. White's `6.d4` reply to `5...Ba5` in the Evans Gambit (path: 11 plies).
2. White's `5.O-O` in a Knight Attack line (path: 9 plies, diverges at move 4).
3. White's `8.Nxe5` continuation in the Evans (path: 15 plies, extends card 1).

Planner output:

- Segment 1: Evans path of length 15 (extended to include card 3's depth),
  with prompts at plyIdx 10 (card 1) and plyIdx 14 (card 3).
- Segment 2: Knight Attack path of length 9, with one prompt at plyIdx 8
  (card 2).

Playback order: Segment 1 first (card 1's dueAt). The user watches moves 1-10
auto-play, prompts for `6.d4`, then sees moves 11-14 auto-play, prompts for
`8.Nxe5`. Then Segment 2: board resets to move 1, auto-plays through Knight
Attack moves, prompts for `5.O-O`.

## Runtime — segmented playback in TrainMode.tsx

When `enterReviewPhase` builds a plan with `plan.segments.length > 0`, the
review phase starts with `segmentIdx=0`, `contextPlyIdx=0`, and
`promptIdxInSegment = indexOfFirstPromptAtOrAfterPly(seg, 0)`.

### The auto-play timer

Lives in the existing useEffect at ~line 414 of `TrainMode.tsx`. When the
phase is segmented review (`phase.plan` present) and `sub === 'await'` and
**not at a prompt**, schedules `advanceSegmentedReviewContext()` after
`OPP_AUTOPLAY_DELAY_MS` (80ms). The advance increments `contextPlyIdx`. If
the new ply is a prompt, the next render shows `sub: 'await'` at the prompt
position and the user takes over. If the new ply is past the segment's
`path.length`, `jumpToNextSegment` fires.

The timer is intentionally the same primitive the walkthrough uses for
opponent moves — same cadence, same feel. Don't fork it without a reason.

### Where SRS grading fires (and where it must NOT)

Only `attemptSegmentedReviewMove` grades. It fires:

- `gradePass(edge)` on correct move **only if `wrongCount === 0`** (first
  attempt). Same as the legacy `attemptReviewMove`.
- `gradeFail(edge)` on wrong move **only if `newSameCount === 1`** (first
  wrong of a run, not subsequent identical retries). Same as legacy.

Critically: `advanceSegmentedReviewContext` (the auto-play step) **does not
grade anything**. Context moves are presentation only. The auto-play timer
walks the user's eyes through stored edges; the SRS doesn't know it
happened.

If you find yourself adding a `gradePass` / `gradeFail` / `putEdge` call
inside any context-advance helper, you've broken the invariant. Stop.

### Edge freshness — `getEdge` before grading

The plan is built at session start. By the time the user reaches a deep
prompt, interim training (passing the shallower prompt that came before it
in the same segment, or another tab) may have already updated the edge's
SRS state. So `attemptSegmentedReviewMove` calls
`getEdge(repertoire.id, parentFen, childFen)` to fetch the latest before
applying `gradePass`/`gradeFail`. Falls back to the in-plan edge if the DB
fetch fails. Same defensive pattern as `completeTestLine`.

### When does a segment end?

`advanceReviewSegmentAfterFlash` (fires after `good-flash`) and
`advanceSegmentedReviewContext` (fires from auto-play) both check
`nextPly >= seg.path.length`. When true, `completeOrRepeatReviewSegment` is
called — which **always** calls `jumpToNextSegment` and advances `segmentIdx`.
When all segments are done, the phase transitions to `{ kind: 'done', mode }`
— same terminal state the legacy review path uses.

**No repeat-until-clean.** An earlier version of `completeOrRepeatReviewSegment`
loop-backed to `restartReviewSegment(p)` when `segmentRunUnclean === true`,
forcing the user to redo the whole segment until a mistake-free pass. That
behavior was undocumented and trapped users in "same line over and over"
loops; removed 2026-05. Missed prompts are now handled exclusively by SRS:
`gradeFail` sets `dueAt = endOfTodayISO` so the failed card is due again
tomorrow morning. `segmentRunUnclean` is still written by the wrong/hint/skip
handlers but is no longer read for control flow (kept in case a future feature
wants to surface "you had X misses on this pass" UI). `restartReviewSegment`
is gone.

### Wrong-answer behavior

Identical to legacy: bad-flash, return to await on the **same prompt**.
`gradeFail` fires on first wrong only. After
`OVERRIDE_AFTER_SAME_WRONG_COUNT` (3) repeats of the same wrong move,
`triggerReviewOverride` is called with the prompt edge — same override
flow Learn uses.

The card stays in its segment. It does not get re-queued to the end of the
session. The next-day session will see it again via SRS (gradeFail sets
`dueAt: endOfTodayISO`, which is "due now" in tomorrow's session).

## Settings toggle — `useLineAwareReview`

`src/lib/trainingPreferences.tsx` carries the boolean (default `true`).
Surfaced in `src/modes/SettingsMode.tsx` under "Training sessions". When
turned off:

- `enterReviewPhase` skips the planner entirely.
- The phase starts without `plan`, so the segmented render branch is
  never entered.
- The user gets the legacy flat-queue UI.

This is the user's escape hatch if the segmented flow has bugs. Don't
remove it.

## Failure surface

When `useLineAwareReview === true` but the planner throws or returns
zero segments while `flatQueue.length > 0`:

- A red error banner appears on the Train setup screen (rendered above
  the Learn/Review buttons). Includes a *Copy review-plan report* button
  that mirrors the Learn failure-report pattern: scope header, counts,
  planner trace, thrown-error stack.
- The session **still proceeds** via the legacy flat-queue render so
  the user can complete their review. The banner persists until the
  next session starts (`setReviewPlanError(null)` fires at the top of
  `startSession` and at the start of a successful planner run).

`buildReviewPlanFailureReport` in `TrainMode.tsx` is the report builder.
Pattern matches `buildFailureReport` (the Learn one) intentionally — same
shape so the user's "Copy report → paste to chat" muscle memory works
for both.

## Scope handling

The planner runs over the scoped edge set. The scope is computed exactly
as the flat queue's scope:

- Folder-scoped: `edgesForOpeningFolder(scopedFolder, allRepEdges, allRepEdges)`
  with `scopeRootFen = scopedFolder.baseFen`. Both arguments are
  `allRepEdges` so the BFS can step through opponent scaffold moves to
  reach user-mover positions — the same trick `enterReviewPhase` uses for
  the flat queue.
- Whole-repertoire: full edge graph with `scopeRootFen = repertoire.rootFen`.

The planner cannot produce a segment that ends outside the scope, because
its BFS only walks `scopedEdges`. The flat queue and the plan can't diverge.

## TUNING / constants reference

| Constant | Value | Effect on segmented review |
| --- | --- | --- |
| `OPP_AUTOPLAY_DELAY_MS` | 80ms | Time between auto-played context moves. Same as walkthrough opponent moves. Raise if feedback is "too fast". |
| `BAD_FLASH_MS` | 110ms | Good-flash / bad-flash duration before advancing or returning to await. |
| `HINT_AFTER_WRONG_COUNT` | 1 | Show arrow on the prompt after this many wrongs. |
| `OVERRIDE_AFTER_SAME_WRONG_COUNT` | 3 | Trigger override prompt after this many repeats of the same wrong move. |
| `trainingPreferences.reviewSessionLength` | user setting (5-30, default 10) | Caps the flat queue before the planner sees it. Segments can therefore prompt at most this many times in one session. |
| `trainingPreferences.useLineAwareReview` | bool (default true) | Master switch for the segmented delivery. |

## Tests — `src/lib/reviewPlan.test.ts`

Ten unit tests covering:

- Single deep due card → single segment.
- Two collinear cards same line → one segment, two prompts.
- Order independence (deeper card listed first still merges).
- Diverging branches → two segments.
- Orphan card (unreachable from scope root) → dropped silently.
- Self-loop (`parentFen === childFen`) → planner returns null path, doesn't
  hang.
- Empty due cards → empty plan.
- dueAt-order preservation across segments.
- `pathFromRootToEdge` reachability tests.

If the planner is changed, the tests *must* be updated to reflect the new
invariants. If a new failure mode is added (a new way a card can be dropped),
add a test that exercises it.

## DO NOT — past failure modes and traps

- **Do not grade context moves.** Only `attemptSegmentedReviewMove` calls
  `gradePass`/`gradeFail`. If a context-advance helper grades, the SRS will
  drift wildly.
- **Do not mutate edges in the planner.** It's read-only over `scopedEdges`.
  No `putEdge`, no `gradeX`, no field assignment. Tests assume this.
- **Do not delete the legacy flat-queue render or the legacy helpers**
  (`attemptReviewMove`, `advanceReviewAfterFlash`, `returnReviewToAwait`,
  `handleSkipReview`). They are the runtime fallback and the user-toggleable
  escape hatch.
- **Do not sort segments by anything other than open-order.** The user chose
  dueAt preservation. If you sort by prompt-count or path-length, you've
  violated the spec.
- **Do not persist the review plan.** It's derived each session from current
  edge state. Persisting would mean schema migration and stale-plan bugs.
  See `docs/wishlist.md` for the deliberate "no persistence" decision.
- **Do not add a `phase.kind === 'review-segmented'` variant.** The plan was
  to extend the existing `'review'` phase. Splitting into two kinds doubles
  the surface area without adding capability.
- **Do not call `pickYourMove` / `pickOpponentMoves` / any Learn-pipeline
  function from the review code.** Review is a delivery layer over stored
  edges. Learn generates new lines. Different pipelines, different
  responsibilities. (See `docs/line-selection.md` for the Learn side.)
- **Do not run the planner over an unscoped edge graph when a folder is
  selected.** It would build paths through the wrong rootFen and produce
  segments outside the user's intended scope.
- **Do not "fix" the dueAt-preserving order by re-sorting at the end.** The
  in-order segment emission *is* the correct behavior. Re-sorting would
  break it.
- **Do not bypass `getEdge` when grading.** Plans hold edge snapshots from
  session start. Always fetch the latest before grading — interim training
  in the same session may have updated SRS state.
- **Do not "improve" the planner by adding LCA / deepest-shared-branch
  ordering without a spec change.** That was deliberately deferred to a v2.
  See `docs/wishlist.md`.
- **Do not add a recursive DFS in `pathFromRootToEdge`.** Use the existing
  iterative BFS with a visited-FEN set. Cyclic repertoire data exists
  (synthetic test covers it).

## Files of record

- **`src/lib/reviewPlan.ts`** — the planner. Pure data, no side effects.
- **`src/lib/reviewPlan.test.ts`** — unit tests.
- **`src/modes/TrainMode.tsx`** — the controller and renderer.
  - Phase type at ~line 71 (the `review` variant carries optional plan fields).
  - `enterReviewPhase` (~line 832) — builds plan, sets phase, surfaces failures.
  - Auto-play timer (~line 414) — segmented branch ≠ legacy branch.
  - Segmented helpers (`isAtPromptNowInSegmentedReview`,
    `advanceSegmentedReviewContext`, `advanceReviewSegmentAfterFlash`,
    `jumpToNextSegment`, `attemptSegmentedReviewMove`,
    `handleSkipSegmentedReview`) live right after the legacy review helpers.
  - Render branch — segmented block appears just above the legacy block;
    both predicate on `phase.kind === 'review'` but the segmented branch
    additionally requires `phase.plan && phase.segmentIdx !== undefined`.
  - `buildReviewPlanFailureReport` + `copyReviewPlanFailureReport` — failure
    banner support.
- **`src/lib/trainingPreferences.tsx`** — `useLineAwareReview` setting +
  default + normalizer.
- **`src/modes/SettingsMode.tsx`** — checkbox UI.
- **`src/lib/review.ts`** — unchanged. `buildReviewQueue` is the planner's
  upstream input. `edgesForOpeningFolder` is reused for scope filtering.
- **`src/lib/srs.ts`** — unchanged. SM-2 logic. Don't touch this when
  changing delivery.
- **`docs/wishlist.md`** — the original spec and the deferred v2 ideas.
- **`docs/line-selection.md`** — Learn-side companion doc; the "three
  algorithms" distinction there is parallel to this doc's "two layers".
