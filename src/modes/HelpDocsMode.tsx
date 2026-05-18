import { useState } from 'react';

// Help & Docs — a growing reference for "how does X actually work?" inside Chesski.
// Currently has one topic (SRS). Add more by extending TOPICS and the topic switch
// below. Mirrors the conceptual content of docs/srs.md so a non-developer can read
// it from inside the app.

type TopicKey = 'srs';

interface Topic {
  key: TopicKey;
  title: string;
  blurb: string;
}

const TOPICS: Topic[] = [
  {
    key: 'srs',
    title: 'How the SRS (spaced-repetition) system works',
    blurb: 'When cards become due, what happens when you pass or fail, and how Learn and Review interact.',
  },
];

export function HelpDocsModal({ onClose }: { onClose: () => void }) {
  const [topic, setTopic] = useState<TopicKey>('srs');

  return (
    <div className="modal-backdrop soft" onClick={onClose}>
      <div
        className="modal help-docs-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-docs-title"
      >
        <div className="help-docs-head">
          <div>
            <div className="eyebrow">Help &amp; Docs</div>
            <h2 id="help-docs-title">How Chesski works</h2>
            <p className="muted small">
              Reference for the parts of Chesski that aren't obvious from the UI. Grows over time —
              right now it covers the spaced-repetition system.
            </p>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close help">×</button>
        </div>

        <div className="help-docs-body">
          <nav className="help-docs-nav" aria-label="Help topics">
            {TOPICS.map(t => (
              <button
                key={t.key}
                className={'help-docs-nav-item' + (t.key === topic ? ' active' : '')}
                onClick={() => setTopic(t.key)}
              >
                <strong>{t.title}</strong>
                <span className="muted small">{t.blurb}</span>
              </button>
            ))}
          </nav>

          <article className="help-docs-content">
            {topic === 'srs' && <SrsExplainer />}
          </article>
        </div>
      </div>
    </div>
  );
}

function SrsExplainer() {
  return (
    <>
      <h3>What this is</h3>
      <p>
        SRS — <em>spaced-repetition scheduling</em> — is the system Chesski uses to decide which
        cards (chess positions, where it's your turn) to quiz you on, and when. The idea: show you
        a card just before you'd otherwise forget it. Get it right → wait longer next time. Get it
        wrong → see it again soon.
      </p>
      <p>
        Chesski's SRS is the SM-2 algorithm, the same one Anki / SuperMemo / Mnemosyne are built on.
        It is intentionally simple: a few numbers stored per card, updated by a few lines of
        arithmetic.
      </p>

      <h3>What a "card" is</h3>
      <p>
        A card in Chesski is a single move in your repertoire — specifically, a move that's
        <em> your color </em>to make. Opponent moves are scaffolding: the system plays them
        automatically when walking through a line, but you're never quizzed on them.
      </p>

      <h3>The numbers stored per card</h3>
      <table className="help-docs-table">
        <thead>
          <tr><th>Field</th><th>What it is</th><th>Starts at</th></tr>
        </thead>
        <tbody>
          <tr><td><code>ease</code></td><td>Interval-growth multiplier. Bigger ease → bigger jumps between reviews.</td><td>2.5</td></tr>
          <tr><td><code>intervalDays</code></td><td>How many days the system last waited before showing this card.</td><td>0</td></tr>
          <tr><td><code>reps</code></td><td>Consecutive passes. Resets to 0 on any fail.</td><td>0</td></tr>
          <tr><td><code>lapses</code></td><td>Total times you've ever failed this card. Never decreases.</td><td>0</td></tr>
          <tr><td><code>dueAt</code></td><td>Timestamp at which the card becomes eligible for review. Card is "due" iff dueAt ≤ now.</td><td>now (so a new card is immediately due)</td></tr>
          <tr><td><code>lastReviewedAt</code></td><td>When you last graded this card.</td><td>never</td></tr>
        </tbody>
      </table>

      <h3>What happens when you pass</h3>
      <p>
        A <strong>pass</strong> means you played the correct move on your first attempt at the
        prompt (no wrongs, no hints, no skips). The system schedules the card forward:
      </p>
      <ul>
        <li><strong>First pass:</strong> 1 day from now.</li>
        <li><strong>Second pass:</strong> 3 days from now.</li>
        <li><strong>Every pass after that:</strong> <code>round(intervalDays × ease)</code> days. With default ease 2.5, the sequence goes 1 → 3 → 8 → 20 → 50 → 125 → 313 days, etc.</li>
      </ul>
      <p>
        Ease stays at 2.5 unless you fail the card. So an unbroken passing streak grows the gap
        geometrically — quickly enough that solidly-known cards effectively vanish from the queue.
      </p>

      <h3>What happens when you fail</h3>
      <p>
        A <strong>fail</strong> means you played the wrong move on first attempt, OR you used a
        hint, OR you skipped. All three are treated identically by the SRS:
      </p>
      <ul>
        <li><code>reps</code> resets to 0.</li>
        <li><code>lapses</code> increments.</li>
        <li><code>ease</code> drops by 0.2, floored at 1.3 (the SM-2 minimum). A card you keep failing eventually has tiny ease, which keeps it close-by until you genuinely lock it in.</li>
        <li><code>dueAt</code> is set to <strong>end of today</strong> (23:59:59 local). In practice this means the card is NOT due again later in today's session, but it'll be due first thing tomorrow.</li>
      </ul>
      <p className="muted small">
        Why end-of-today and not "5 minutes from now"? Because mid-session re-drilling is the
        delivery layer's job, not the SRS layer's. The SRS layer just says "you missed this; tomorrow
        you'll see it again."
      </p>

      <h3>What "due" means</h3>
      <p>
        A card is due iff its <code>dueAt</code> is in the past. There's no concept of "overdue" as
        a separate state — a card due 3 days ago and a card due right now are both just "due". The
        review queue is sorted by <code>dueAt</code> ascending, so longest-overdue cards come first.
      </p>

      <h3>How the queue is built each session</h3>
      <ol>
        <li>Take all your-color edges in the active scope (repertoire-wide or folder-restricted).</li>
        <li>Filter to the ones that are due.</li>
        <li>Sort by <code>dueAt</code>, oldest first.</li>
        <li>Cap to your "Review session length" setting (default 10).</li>
        <li>If nothing is due AND you're in Learn-and-Review mode, fall back to least-recently-reviewed cards so the session isn't empty.</li>
      </ol>

      <h3>Learn vs Review — who creates and who updates</h3>
      <p>
        <strong>Learn mode</strong> creates new edges (with fresh SRS state — ease 2.5, due now)
        and walks you through them. When you accept a move in Learn, the system marks it
        learn-passed — reps bumps to 1, but the card stays due so it'll appear in the next Review.
      </p>
      <p>
        <strong>Review mode</strong> only updates existing edges via pass/fail. It never creates
        new edges. The queue is just whatever's due, in dueAt order, capped by your session length.
      </p>

      <h3>First-try-only grading</h3>
      <p>
        Each prompt is graded once per session. Once you've played any move (right or wrong) for a
        given prompt, the SRS state for that card is set in stone for the rest of the session. This
        is important because:
      </p>
      <ul>
        <li>A wrong-then-correct sequence is graded as a <strong>fail</strong>. The card is due tomorrow, not in 8 days.</li>
        <li>If you then play the same wrong move three times in a row, an override prompt appears that lets you change the repertoire's stored move. That flow is separate from SRS — overriding doesn't grade further.</li>
        <li>Using a hint or skipping also counts as a fail and grades the card.</li>
      </ul>

      <h3>The segmented delivery layer</h3>
      <p>
        When you have multiple due cards on the same line, the review session merges them into a
        <em> segment</em> — one continuous walk-through where you're prompted at each due card's ply
        and the system auto-plays the connecting moves. After one pass-through, the session advances
        to the next segment. Missed prompts will resurface tomorrow via SRS (since they were graded
        as fail and dueAt is end-of-today).
      </p>

      <h3>Debugging — "why is this card behaving this way?"</h3>
      <ul>
        <li><strong>Open the card's SRS state in the review walkthrough.</strong> The Show SRS panel during review reveals the per-card numbers.</li>
        <li><strong>Check <code>dueAt</code>.</strong> If it's in the past, the card is correctly due.</li>
        <li><strong>Check <code>reps</code> vs <code>lapses</code>.</strong> High lapses with reps stuck at 0 means you've been failing it.</li>
        <li><strong>Check <code>ease</code>.</strong> If it's 1.3, the floor, intervals grow slowly — correct behavior for a card you've failed many times.</li>
        <li><strong>Wrong-then-right is a fail.</strong> If you visually "got it right" and the card still shows up tomorrow, you almost certainly wronged it on first try and corrected. SRS counted the fail.</li>
      </ul>

      <h3>Reference</h3>
      <p className="muted small">
        Full developer-facing version lives at <code>docs/srs.md</code> in the repo, with
        implementation pointers, edge cases, and a "DO NOT" list for future maintainers.
      </p>
    </>
  );
}
