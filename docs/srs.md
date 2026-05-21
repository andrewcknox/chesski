# SRS — how spaced-repetition scheduling works in Chesski

**Audience: both humans and future Claude (or other LLM) sessions.** Read this when you want to understand why a particular card is due, when it'll be due again after a pass/fail, or how the SRS layer interacts with Learn and Review modes. Companion to [review-flow.md](review-flow.md), which covers the *delivery* layer (how due cards are presented).

## Background — what SRS is

Spaced Repetition Scheduling (SRS) shows you cards just before you'd otherwise forget them. Get a card right → the system waits longer before quizzing you again. Get it wrong → it brings the card back soon. The idea is that the gap between reviews should grow as your memory solidifies, so each review costs minimal effort for maximum retention.

Chesski uses **SM-2**, the algorithm from SuperMemo-2 / Anki / Mnemosyne. Each card carries a few numbers; on every review those numbers update according to the grade you got. There is no neural net, no priority queue tuning, no fancy heuristics — it's a few lines of arithmetic, applied per card, every time you review it. The whole thing lives in [src/lib/srs.ts](../src/lib/srs.ts) and is about 70 lines.

## What is a "card"?

In Chesski, a **card** is an `Edge` — a single move in your repertoire. An edge has:
- A parent FEN (the board position before the move)
- A child FEN (the board position after)
- The move itself (SAN + UCI)
- Whose move it is (`mover: 'w' | 'b'`)
- SRS state (the fields below)
- Provenance / source metadata

**Only edges where it's your color to move are graded.** Opponent-color edges are *scaffolding*: the system plays them automatically during review walks but doesn't quiz you on them. If you're White, the engine's `b8c6` reply to your `1.e4 e5 2.Nf3` exists as an edge so the path from root to deeper White cards can be walked, but it's never a card you have to recall.

## The per-card SRS state

Every edge stores these fields ([src/types.ts:34](../src/types.ts:34)):

| Field | Type | What it is | Initial value (`freshSrsState`) |
| --- | --- | --- | --- |
| `ease` | number | Interval-growth multiplier. Higher = bigger jumps after a pass. SM-2 minimum is 1.3; default 2.5. | `2.5` |
| `intervalDays` | number | How many days the system waited before showing this card *most recently*. Multiplied by ease to compute the next interval. | `0` |
| `reps` | number | How many consecutive passes you've had on this card. Resets to 0 on any fail. | `0` |
| `lapses` | number | Total number of times you've ever failed this card. Never decreases. | `0` |
| `dueAt` | ISO string | Timestamp at which the card becomes eligible for review. | `now` (so a new card is immediately due) |
| `lastReviewedAt` | ISO string \| null | When you last graded it. `null` if never reviewed. | `null` |

## What "due" means

A card is **due** if `new Date(edge.dueAt) <= new Date()`. Implementation: [`isDue` in srs.ts](../src/lib/srs.ts).

There's no concept of "overdue" as a separate state — a card whose dueAt was 3 days ago and a card whose dueAt is right now are both just "due". The review queue is sorted by `dueAt ascending`, so the cards that have been due longest come first. If a card's dueAt is in the future, it's not due.

The `Date` comparison uses local time on the user's device. There's no server clock involved.

## The four grade functions

### `gradePass(edge)` — passing on the first try

Used when you played the correct move on your first attempt at this prompt. (A wrong-then-correct sequence does NOT call gradePass — see "first-try-only grading" below.)

The update:

```
ease                      ← unchanged
lapses                    ← unchanged
reps                      ← reps + 1
intervalDays              ← if reps was 0:  1
                             if reps was 1:  3
                             if reps was ≥2: round(intervalDays × ease)
dueAt                     ← now + intervalDays days
lastReviewedAt            ← now
```

So a brand-new card that you pass on first review schedules itself for *tomorrow*. Pass it again tomorrow, it goes to *3 days*. Pass it again, it goes to `round(3 × 2.5) = 8` days. The next would be `round(8 × 2.5) = 20`, then 50, then 125, then 313, etc. — **the interval grows geometrically with each pass.**

The geometric factor *is* the `ease`. Ease stays at 2.5 unless you fail the card.

### `gradeFail(edge, options?)` — failing the first attempt

Used when you played a *wrong* move (the first call per card per session — see "Multi-grade within one session" below for what happens on later wrongs).

The update:

```
ease                      ← max(1.3, ease - 0.2)
reps                      ← 0
lapses                    ← lapses + 1
intervalDays              ← 0
dueAt                     ← now + relearnMinutes  (default 5; Anki-style relearning)
lastReviewedAt            ← now
```

`options.relearnMinutes` defaults to `DEFAULT_RELEARN_MINUTES` (5). The setting is user-tunable from Settings → SRS system settings → Relearn interval, range 1–60 minutes. The chosen value is captured into the review phase at session start (`reviewSessionRelearnMinutes`) so mid-session settings changes don't shift dueAt unexpectedly.

So failing:

- **Drops ease by 0.2**, floored at 1.3 (the SM-2 minimum). Once a card's ease is 1.3, every future interval grows slowly — `round(intervalDays × 1.3)`. This is intentional: cards you keep failing should not stay on a long schedule.
- **Resets reps to 0**, so the next pass goes back to the 1-day step.
- **Schedules the card for now + relearnMinutes.** Default 5 minutes. The card stays "due" for the rest of the day — a later same-day review session will pick it up again. Within the same session, the *delivery layer* re-prompts you via the segment-repeat loop (see [review-flow.md](review-flow.md)); SRS itself just sets the dueAt and gets out of the way.

### `gradeFail` with `skipCompound: true` — refresh dueAt only

When a card has already been graded fail earlier in this session (tracked by `failedPromptIdsThisSession` on the review phase), subsequent fails on the same card should NOT compound the ease drop or bump lapses again. Pass `options.skipCompound = true`:

```
ease                      ← unchanged
reps                      ← unchanged
lapses                    ← unchanged
intervalDays              ← unchanged
dueAt                     ← now + relearnMinutes  (refreshed from this attempt)
lastReviewedAt            ← now
```

The callers (`attemptSegmentedReviewMove`, `attemptReviewMove`, `revealCurrentHint`, `handleSkipSegmentedReview`) check `failedPromptIdsThisSession.includes(edge.id)` before deciding whether to pass `skipCompound`. See "Multi-grade within one session" below.

### `gradeLearnPass(edge)` — learning a brand-new card

Used during the **Learn** phase when you grasp a never-before-seen card via the walkthrough flow. It's distinct from `gradePass` because the card hasn't actually been "reviewed" in the SRS sense — you were taught it, not tested on it.

The update:

```
ease                      ← unchanged
lapses                    ← unchanged
reps                      ← reps + 1
intervalDays              ← 0
dueAt                     ← now (immediately due)
lastReviewedAt            ← now
```

So a Learn-passed card is *still due*. It will enter the next review queue. Why bump `reps` then? Because if you then pass it during review (a separate gradePass call), the reps-was-1 branch fires and the next interval is 3 days, skipping the trivial 1-day step. You're treated as "already familiar."

### `freshSrsState()` — the initial state for a newly-created edge

This is what every brand-new edge gets when Learn mode adds it to the repertoire (either as a card you'll have to fill in, or as opponent scaffolding):

```
ease           = 2.5
intervalDays   = 0
reps           = 0
lapses         = 0
dueAt          = now (immediately due)
lastReviewedAt = null
```

Functionally identical to `gradeLearnPass(edge)` if `reps` was already 0 — but `freshSrsState` is for edges that don't yet exist.

## Multi-grade within one session

A prompt can be graded multiple times in one session — that's the design now. The new "segment-repeat until clean pass" delivery (see [review-flow.md](review-flow.md)) means the user re-encounters the same prompt across multiple passes through the same segment, and we need rules for what each subsequent grade does.

Two session-scoped sets on the review phase drive the logic:

- **`gradedPromptEdgeIds`** — edges where `gradePass` has fired this session. Used to suppress re-grading on subsequent correct plays. Cleared from the set when an edge is later failed (a passed card that's later failed is no longer "passed").
- **`failedPromptIdsThisSession`** — edges where `gradeFail` has fired with full compounding this session. Subsequent fails on the same edge in the same session refresh dueAt via `skipCompound` (no further ease drop, no further lapses bump). Also used to *block* `gradePass` on right-after-wrong runs: once a card has been failed this session, no later right move can promote it.

The rules, applied per attempt at a prompt:

- **Right on first try, never failed this session, never passed this session** → `gradePass` fires. dueAt jumps to 1/3/8/… days. Add to `gradedPromptEdgeIds`.
- **Right, but already in `failedPromptIdsThisSession`** → no `gradePass`. The card stays at +relearnMinutes (the original fail's schedule). This is the "right after wrong" rule: a card you missed during this session is not promoted, even if you eventually get it right.
- **Right, but already in `gradedPromptEdgeIds`** (already passed this session, never failed) → no re-grade. Card stays at the already-pushed-forward dueAt.
- **Wrong, never failed this session** → full `gradeFail`. ease −0.2, lapses+1, reps=0, dueAt = +relearnMinutes. Add to `failedPromptIdsThisSession`. If the card was previously in `gradedPromptEdgeIds` this session (right→then→wrong), remove it from that set — the fail supersedes the pass.
- **Wrong, already failed this session** → `gradeFail` with `skipCompound: true`. dueAt refreshes to +relearnMinutes from this attempt. ease and lapses do NOT compound.

The override flow (`OVERRIDE_AFTER_SAME_WRONG_COUNT` identical wrong moves in a row) is unchanged and runs independent of these rules.

Practical implications:

- If you fail a card then later get it right in the same session, it ends the session in fail state (ease dropped once, dueAt = +relearnMinutes). It will reappear in a later same-day session via the relearn interval.
- If you keep playing the same wrong move three times, the override prompt appears (separate from SRS — it lets you accept the wrong move as a new repertoire choice).
- Hints and skips count as fails — they go through the same rules above. A single hint click on a pass is enough to mark that pass unclean (so the segment will restart) and to schedule the card at +relearnMinutes. The hint UI tints the from-square of the stored move only — not the to-square, and not a move arrow — so the user still has to recall where the piece goes.
- A pass→fail→right within one session ends in fail state (ease dropped, dueAt = +relearnMinutes). The pass-1 schedule is reversed by the pass-2 gradeFail; pass-3 right cannot un-reverse it.

The same per-session guard is also applied in the legacy flat-queue review (`attemptReviewMove`), so the flat path can't compound ease/lapses on the rare cases where a card appears more than once in a session.

## How cards enter the queue

[`buildReviewQueue` in src/lib/review.ts](../src/lib/review.ts):

1. Take all user-color edges in scope (scope-filtered upstream by `edgesForOpeningFolder` if a folder is selected; otherwise the full repertoire).
2. Filter to `isDue(edge)`.
3. Sort by `dueAt ascending` (longest-overdue first).
4. Cap the result to `reviewSessionLength` (a per-user setting, default 10).
5. If the result is empty AND learn-and-review mode is active AND fallback is requested, supplement with edges sorted by least-recently-reviewed, so the user always gets *something* to practice. (This fallback is what keeps the system useful when nothing's strictly due.)

The line-aware delivery layer (see [review-flow.md](review-flow.md)) consumes the output of `buildReviewQueue` and re-organizes it into segments — multiple due cards on the same line are merged into a single playback. The SRS layer doesn't know or care about that re-organization.

## Learn vs Review — who creates and who updates

| Mode | What it does to SRS state |
| --- | --- |
| **Learn** | *Creates* edges with `freshSrsState`. Walking through a generated line in the Walkthrough phase calls `gradeLearnPass` on each user-move edge as you accept it. The optional follow-up Test phase calls `gradePass` (clean) or `gradeFail` (mistakes). |
| **Review** | Only *updates* existing edges via `gradePass` / `gradeFail`. Never creates edges. The queue is whatever's due, in dueAt order, capped at `reviewSessionLength`. |

Both modes update the same per-edge fields. A card you Learn-passed today might appear in tomorrow's Review queue and get bumped to a 1-day interval by `gradePass`. A card you fail in Review today is due again tomorrow and the cycle repeats.

## Worked examples

### A successful learning trajectory

You see a new prompt — `3.Bc4` after `1.e4 e5 2.Nf3 Nc6`. Initial state: `ease=2.5, reps=0, intervalDays=0, dueAt=today, lapses=0`. You walk it in Learn, you understand it: `gradeLearnPass` fires → `reps=1, dueAt=today` (still due). You then review it in the same session and get it right: `gradePass` fires; since `reps was 1`, `intervalDays=3`, `dueAt=now+3 days, reps=2`. Three days later you pass it again: `intervalDays = round(3*2.5) = 8`, `dueAt=now+8, reps=3`. Eight days later: `intervalDays = round(8*2.5) = 20`, `reps=4`. The card spaces itself out automatically as you keep remembering it.

### A card you keep getting wrong

You hit `3.Bc4`. `ease=2.5, reps=2, intervalDays=8, lapses=0`. You play `3.Bb5` (wrong). `gradeFail` fires: `ease=2.3, reps=0, lapses=1, intervalDays=0, dueAt = now + 5 min`. The within-session segment loop re-prompts you until you get one clean pass through the segment; if you keep missing this card on later passes, dueAt refreshes (skipCompound) but ease/lapses don't move again. You complete the session; ~5 minutes later, a new session can pick it up — `gradeFail` fires only if you miss it AGAIN (a fresh session is a fresh failedPromptIdsThisSession set), in which case `ease=2.1, lapses=2`. After enough failed sessions, `ease=1.3` (floor). Now every pass only multiplies by 1.3: 1 → 3 → 4 → 5 → 7 days. The card stays close-by until you genuinely lock it in.

### A card you've been crushing for months

`ease=2.5, reps=12, intervalDays=2300` (over 6 years). `dueAt` is in the distant future. The card doesn't appear in any review queue. If you ever fail it, the schedule collapses back to `dueAt = now + 5 min, reps=0, ease=2.3`. SM-2 doesn't have a separate "leech" concept built into the SRS layer — a card that's failed twice from a long interval will just rebuild slowly. (Leech tagging for cards failed across N consecutive sessions is on the wishlist; see [wishlist.md](wishlist.md).)

## Debugging — "why is this card behaving this way?"

1. **Open the card's edge in IndexedDB** (`chesski` DB → `edges` store, key by edge id). Look at `dueAt`, `reps`, `intervalDays`, `ease`, `lapses`, `lastReviewedAt`.
2. **Check `dueAt`.** If it's in the past, the card is correctly due. If it's in the future, it shouldn't be appearing — if it is, look at the review queue building.
3. **Check `reps` vs `lapses`.** A card you've been struggling with will have high `lapses` and a `reps` that resets to 0 each time. If reps stays at 0 forever, you've failed it on every attempt.
4. **Check `ease`.** If it's 1.3, the SM-2 floor, intervals are growing slowly. This is correct for a card you've failed a lot.
5. **Check whether grade functions are firing.** A wrong-then-right sequence within one session does NOT call `gradePass` — the card stays in fail state with `dueAt = +relearnMinutes`. The user sees a "correct" flash but the SRS state's dueAt is minutes from now, not days. This is the most common source of "I got it right but it's still coming back."
6. **Check the relearn interval.** A failed card has `dueAt = now + relearnMinutes` (default 5). It'll reappear in any later same-day review session. The within-session segment-repeat loop also re-prompts you without touching SRS (delivery-layer behavior — see [review-flow.md](review-flow.md)).

## Edge cases and gotchas

- **Ease floor:** `ease` is floored at 1.3 — the SM-2 minimum. Below that, intervals barely grow. Above the floor it's whatever you've been graded to.
- **No ease ceiling:** A card with `ease=2.5` that you keep passing will eventually have `intervalDays` in the thousands. There's no cap. If you set a long enough horizon and pass consistently, cards effectively disappear from the queue.
- **`gradeLearnPass` is the only grade that keeps dueAt at *now*.** All other grades push it forward (one to many days for pass, +relearnMinutes for fail).
- **There's no neutral / "easy" / "hard" grade.** SM-2 in SuperMemo proper has 5 grades (0-5); Chesski collapses them to pass/fail with a separate learn-pass for the initial walkthrough. If you want finer control, you'd need to extend `srs.ts` and the callers in `TrainMode.tsx`.
- **Scaffold edges (opponent moves) carry SRS state too.** It's just never consulted. This is wasted bytes in IndexedDB but keeps the schema uniform — every edge has the same shape regardless of mover.

## Files of record

- **[src/lib/srs.ts](../src/lib/srs.ts)** — `isDue`, `gradePass`, `gradeFail`, `gradeLearnPass`, `freshSrsState`, `endOfTodayISO`, `addDaysISO`. Pure logic, no I/O.
- **[src/lib/review.ts](../src/lib/review.ts)** — `buildReviewQueue` (consumes the SRS state, produces a queue), `edgesForOpeningFolder` (scope filter).
- **[src/types.ts](../src/types.ts)** — the `Edge` interface includes all SRS fields. Same shape for user-color and opponent-color edges.
- **[src/modes/TrainMode.tsx](../src/modes/TrainMode.tsx)** — calls the grade functions in `attemptReviewMove`, `attemptSegmentedReviewMove`, `persistSegmentedReviewGrade`, `revealCurrentHint`, `handleSkipReview`, `handleSkipSegmentedReview`, `triggerReviewOverride`, and the test-phase completion path.
- **[src/lib/storage.ts](../src/lib/storage.ts)** — `getEdge`, `putEdge`, IndexedDB persistence. `getEdge` is the canonical way to fetch the latest SRS state before grading (because the in-memory plan/queue snapshots can lag).
- **[docs/review-flow.md](review-flow.md)** — covers the *delivery* layer (how due cards are presented as Chessable-style segments). Strictly above the SRS layer; never mutates SRS state directly.

## DO NOT

- **Do not grade context moves.** During segmented review, auto-played opponent (and user) moves between prompts are presentation only. Only the prompt edge gets graded. (Repeated from review-flow.md for clarity.)
- **Do not call `gradePass` on a wrong-then-right run.** Right-after-wrong stays in fail state — see "Multi-grade within one session" above. If you want a "you eventually got it right" credit, talk to the user first — it's a real product decision.
- **Do not compound ease/lapses across same-session fails of the same card.** Subsequent fails on a card already in `failedPromptIdsThisSession` must pass `skipCompound: true` to `gradeFail`. Without that guard, one bad session can tank a card's ease to the 1.3 floor.
- **Do not bring back `endOfTodayISO` scheduling for fail.** The +relearnMinutes scheduling is intentional — failed cards reappear in later same-day sessions (Anki-style relearning). The within-session segment-repeat loop handles same-pass re-prompting.
- **Do not raise the ease floor above 1.3.** It's the SM-2 spec value. Above 1.3, hard cards grow intervals too fast and never settle.
- **Do not introduce a new `grade…` function** without first asking whether the existing four suffice. They cover every situation Chesski has needed so far. New grades fragment the persistence story and confuse the call sites.
- **Do not store SRS state anywhere other than the edge.** No separate "card history" store. The edge IS the card.
- **Do not "improve" SM-2 by adding leech detection or priority overrides** without product sign-off. They sound nice but quickly become hard to reason about; the current setup is intentionally minimal.
