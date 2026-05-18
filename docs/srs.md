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

### `gradeFail(edge)` — failing the first attempt

Used when you played a *wrong* move (first wrong attempt at a prompt — subsequent identical wrongs don't re-grade). See "first-try-only grading" below.

The update:

```
ease                      ← max(1.3, ease - 0.2)
reps                      ← 0
lapses                    ← lapses + 1
intervalDays              ← 0
dueAt                     ← end of today (23:59:59 local)
lastReviewedAt            ← now
```

So failing:

- **Drops ease by 0.2**, floored at 1.3 (the SM-2 minimum). Once a card's ease is 1.3, every future interval grows slowly — `round(intervalDays × 1.3)`. This is intentional: cards you keep failing should not stay on a long schedule.
- **Resets reps to 0**, so the next pass goes back to the 1-day step.
- **Schedules the card for end of today** — `23:59:59` on the user's local date. In practice this means the card is NOT due again later today (your session ends, midnight rolls over, then it's due again first thing tomorrow). The next-day delivery is the safety net for missed prompts.

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

## First-try-only grading

Both review delivery modes (segmented and flat-legacy) grade each prompt **once** per session:

- **`gradePass`** fires only if `wrongCount === 0` (no wrong attempts on this prompt yet) AND the prompt isn't already in the session's `gradedPromptEdgeIds` set.
- **`gradeFail`** fires on the *first* wrong attempt at a prompt. Subsequent wrongs at the same prompt — even different wrong moves — do NOT re-grade. Subsequent *identical* wrong moves bump `sameWrongCount`, which can trigger an override flow if it reaches `OVERRIDE_AFTER_SAME_WRONG_COUNT`.

`gradedPromptEdgeIds` is session-scoped. Closing and reopening the session resets it.

Practical implications:

- If you make a wrong move and then play the correct move, the card is graded as a *fail*, not a pass. `dueAt` goes to `endOfTodayISO`, and the card is due again tomorrow.
- If you use a hint (or skip a prompt), the system grades it as a fail. Same effect.
- If you fail a prompt and then keep playing the same wrong move three times, an override prompt appears that lets you accept the wrong move as a new repertoire choice. That flow is separate from SRS — the override doesn't grade further.

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

You hit `3.Bc4`. `ease=2.5, reps=2, intervalDays=8, lapses=0`. You play `3.Bb5` (wrong). `gradeFail` fires: `ease=2.3, reps=0, lapses=1, intervalDays=0, dueAt=endOfTodayISO`. Next morning it's due. You fail again: `ease=2.1, lapses=2`. After enough failures, `ease=1.3` (floor). Now every pass only multiplies by 1.3: 1 → 3 → 4 → 5 → 7 days. The card stays close-by until you genuinely lock it in.

### A card you've been crushing for months

`ease=2.5, reps=12, intervalDays=2300` (over 6 years). `dueAt` is in the distant future. The card doesn't appear in any review queue. If you ever fail it, the schedule collapses back to `dueAt=endOfTodayISO, reps=0, ease=2.3`. SM-2 doesn't have a separate "leech" concept — a card that's failed twice from a long interval will just rebuild slowly.

## Debugging — "why is this card behaving this way?"

1. **Open the card's edge in IndexedDB** (`chesski` DB → `edges` store, key by edge id). Look at `dueAt`, `reps`, `intervalDays`, `ease`, `lapses`, `lastReviewedAt`.
2. **Check `dueAt`.** If it's in the past, the card is correctly due. If it's in the future, it shouldn't be appearing — if it is, look at the review queue building.
3. **Check `reps` vs `lapses`.** A card you've been struggling with will have high `lapses` and a `reps` that resets to 0 each time. If reps stays at 0 forever, you've failed it on every attempt.
4. **Check `ease`.** If it's 1.3, the SM-2 floor, intervals are growing slowly. This is correct for a card you've failed a lot.
5. **Check whether grade functions are firing.** In segmented review, a wrong-then-right sequence does NOT call `gradePass` — the card keeps its old `dueAt`. The user sees a "correct" flash but the SRS state hasn't moved. This is the most common source of "I got it right but it's still showing up tomorrow."
6. **Check the daily roll-over.** A failed card has `dueAt = endOfTodayISO`, which means *very end of today*. Late in the day, that's seconds away — when midnight passes, the card is due again. In practice this almost always means "due next session."

## Edge cases and gotchas

- **Ease floor:** `ease` is floored at 1.3 — the SM-2 minimum. Below that, intervals barely grow. Above the floor it's whatever you've been graded to.
- **No ease ceiling:** A card with `ease=2.5` that you keep passing will eventually have `intervalDays` in the thousands. There's no cap. If you set a long enough horizon and pass consistently, cards effectively disappear from the queue.
- **`gradeLearnPass` is the only grade that keeps dueAt at *now*.** All other grades push it forward (one to many days for pass, end-of-today for fail).
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
- **Do not call `gradePass` on a wrong-then-right run.** First-try-only is the spec. If you want a "you eventually got it right" credit, talk to the user first — it's a real product decision, not a refactor.
- **Do not change `gradeFail`'s dueAt to "in 1 hour" or "in 5 minutes."** End-of-today is the safety net. Mid-session re-practice is the delivery layer's job (see review-flow.md), not the SRS layer's.
- **Do not raise the ease floor above 1.3.** It's the SM-2 spec value. Above 1.3, hard cards grow intervals too fast and never settle.
- **Do not introduce a new `grade…` function** without first asking whether the existing four suffice. They cover every situation Chesski has needed so far. New grades fragment the persistence story and confuse the call sites.
- **Do not store SRS state anywhere other than the edge.** No separate "card history" store. The edge IS the card.
- **Do not "improve" SM-2 by adding leech detection or priority overrides** without product sign-off. They sound nice but quickly become hard to reason about; the current setup is intentionally minimal.
