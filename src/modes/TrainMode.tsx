import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Board } from '../components/Board';
import { applyMove, turnAt } from '../lib/chess';
import { continueLearnLine, generateLearnLine, evaluateMoveCpLoss, TUNING, type GeneratedLine } from '../lib/autosuggest';
import { getEdgesByMover, getEdgesForRepertoire, putEdge, swapMoveInRepertoire } from '../lib/storage';
import { gradeFail, gradePass, isDue } from '../lib/srs';
import {
  buildHistoryCardStates,
  freshHistoryProgress,
  getHistoryProgress,
  gradeHistory,
  isHistoryDue,
  saveHistoryProgress,
  type HistoryCardState,
  type ProgressByCard,
} from '../lib/historySrs';
import type { Edge, Repertoire } from '../types';

type SessionMode = 'learn-and-review' | 'learn-only' | 'review-only';
type Sub = 'await' | 'bad-flash' | 'good-flash';
type PillState = 'pending' | 'current' | 'done' | 'failed';

type Phase =
  | { kind: 'setup' }
  | { kind: 'generating'; mode: SessionMode }
  | { kind: 'walkthrough'; line: GeneratedLine; cursorIdx: number; mode: SessionMode; sub: Sub; lastWrongUci: string | null; sameWrongCount: number; wrongCount: number }
  | { kind: 'override-prompt'; line: GeneratedLine; cursorIdx: number; mode: SessionMode; bestSan: string; attemptedSan: string; attemptedUci: string; cpLoss: number | null; resolving: boolean; comesFrom: 'walkthrough' | 'test' }
  | { kind: 'test'; line: GeneratedLine; cursorIdx: number; gradedEdges: Set<string>; passHadError: boolean; passNumber: number; mode: SessionMode; sub: Sub; lastWrongUci: string | null; sameWrongCount: number; wrongCount: number }
  | { kind: 'review'; queue: Edge[]; idx: number; mode: SessionMode; sub: Sub; lastWrongUci: string | null; sameWrongCount: number; wrongCount: number }
  | { kind: 'done'; mode: SessionMode };

interface SessionStats {
  learnPassed: number;
  learnFailed: number;
  reviewPassed: number;
  reviewFailed: number;
  reviewSkipped: number;
  switched: number;
  linesLearned: number;
}

const REVIEW_QUEUE_CAP = 10;
const OPP_AUTOPLAY_DELAY_MS = 80;
const BAD_FLASH_MS = 110;
const HINT_AFTER_WRONG_COUNT = 2;
const OVERRIDE_AFTER_SAME_WRONG_COUNT = 3;

export interface TrainModeProps {
  repertoire: Repertoire;
  onDataChange: () => void;
  refreshKey: number;
  boardSize: number;
  onBoardSizeChange: (size: number) => void;
}

export function TrainMode({ repertoire, onDataChange, refreshKey, boardSize, onBoardSizeChange }: TrainModeProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const [stats, setStats] = useState<SessionStats>(emptyStats());
  const [allEdges, setAllEdges] = useState<Edge[]>([]);
  const [genError, setGenError] = useState<string | null>(null);
  const [queuedPremove, setQueuedPremove] = useState<{ from: string; to: string; promotion?: string } | null>(null);
  const [animateComputerMove, setAnimateComputerMove] = useState(false);
  const [loadingHistoryProgress, setLoadingHistoryProgress] = useState<ProgressByCard>({});
  const [loadingHistoryAnswerShown, setLoadingHistoryAnswerShown] = useState(false);

  const reload = useCallback(async () => {
    const es = await getEdgesForRepertoire(repertoire.id);
    setAllEdges(es);
  }, [repertoire.id]);

  useEffect(() => { void reload(); }, [reload, refreshKey]);
  useEffect(() => { setPhase({ kind: 'setup' }); setStats(emptyStats()); setQueuedPremove(null); }, [repertoire.id]);
  useEffect(() => {
    (async () => setLoadingHistoryProgress(await getHistoryProgress()))();
  }, [refreshKey]);

  const dueCount = useMemo(() => {
    const now = new Date();
    return allEdges.filter(e => e.mover === repertoire.color && isDue(e, now)).length;
  }, [allEdges, repertoire.color]);

  const branchCount = useMemo(() => countBranches(repertoire.rootFen, allEdges), [repertoire.rootFen, allEdges]);

  // Auto-advance opponent moves and bad-flash recovery.
  const phaseRef = useRef(phase);
  const previousPhaseRef = useRef<Phase | null>(null);
  phaseRef.current = phase;

  useEffect(() => {
    const prev = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    if (!prev || (prev.kind !== 'walkthrough' && prev.kind !== 'test') || (phase.kind !== 'walkthrough' && phase.kind !== 'test')) return;
    const prevEdge = prev.line.fullPath[prev.cursorIdx];
    const curEdge = phase.line.fullPath[phase.cursorIdx];
    if (prevEdge?.mover !== repertoire.color && curEdge?.mover === repertoire.color && phase.cursorIdx > prev.cursorIdx) {
      setAnimateComputerMove(true);
      const timer = setTimeout(() => setAnimateComputerMove(false), 120);
      return () => clearTimeout(timer);
    }
  }, [phase, repertoire.color]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (phase.kind === 'walkthrough' || phase.kind === 'test') {
      const cur = phase.line.fullPath[phase.cursorIdx];
      if (phase.sub === 'await' && cur && cur.mover !== repertoire.color) {
        timer = setTimeout(() => advanceCursor(), OPP_AUTOPLAY_DELAY_MS);
      } else if (phase.sub === 'good-flash') {
        timer = setTimeout(() => advanceCursor(), BAD_FLASH_MS);
      } else if (phase.sub === 'bad-flash') {
        timer = setTimeout(() => returnToAwait(), BAD_FLASH_MS);
      }
    } else if (phase.kind === 'review') {
      if (phase.sub === 'good-flash') {
        timer = setTimeout(() => advanceReviewAfterFlash(), BAD_FLASH_MS);
      } else if (phase.sub === 'bad-flash') {
        timer = setTimeout(() => returnReviewToAwait(), BAD_FLASH_MS);
      }
    }
    return () => { if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (!queuedPremove) return;
    if (phase.kind !== 'walkthrough' && phase.kind !== 'test') return;
    if (phase.sub !== 'await') return;
    const cur = phase.line.fullPath[phase.cursorIdx];
    if (!cur || cur.mover !== repertoire.color) return;
    setQueuedPremove(null); // eslint-disable-line react-hooks/set-state-in-effect
    void attemptUserMove(queuedPremove);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, queuedPremove, repertoire.color]);

  // ---------- Session entry ----------

  async function startSession(mode: SessionMode) {
    setStats(emptyStats());
    setGenError(null);
    if (mode === 'review-only') {
      enterReviewPhase(mode);
      return;
    }
    setLoadingHistoryAnswerShown(false);
    setPhase({ kind: 'generating', mode });
    let line: GeneratedLine | null;
    try {
      line = await generateLearnLine(repertoire);
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
      setPhase({ kind: 'setup' });
      return;
    }
    if (!line) {
      setGenError('No frontier to learn — repertoire fully covered (or Lichess data unavailable).');
      setPhase({ kind: 'setup' });
      return;
    }
    await reload();
    onDataChange();
    setPhase({
      kind: 'walkthrough', line, cursorIdx: line.generationStartIndex, mode,
      sub: 'await', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0,
    });
  }

  async function gradeLoadingHistoryCard(cardId: string, knewIt: boolean) {
    const current = loadingHistoryProgress[cardId] ?? freshHistoryProgress();
    const updated = { ...loadingHistoryProgress, [cardId]: gradeHistory(current, knewIt ? 'known' : 'unknown') };
    setLoadingHistoryProgress(updated);
    setLoadingHistoryAnswerShown(false);
    await saveHistoryProgress(updated);
    onDataChange();
  }

  function enterReviewPhase(mode: SessionMode) {
    const now = new Date();
    const queue = allEdges
      .filter(e => e.mover === repertoire.color && isDue(e, now))
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
      .slice(0, REVIEW_QUEUE_CAP);
    if (queue.length === 0) {
      setPhase({ kind: 'done', mode });
      return;
    }
    setPhase({ kind: 'review', queue, idx: 0, mode, sub: 'await', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0 });
  }

  // ---------- Walkthrough / Test shared logic ----------

  async function attemptUserMove(move: { from: string; to: string; promotion?: string }): Promise<boolean> {
    const p = phaseRef.current;
    if (p.kind !== 'walkthrough' && p.kind !== 'test') return false;
    if (p.sub !== 'await') return false;
    const edge = p.line.fullPath[p.cursorIdx];
    if (!edge || edge.mover !== repertoire.color) return false;
    const result = applyMove(edge.parentFen, move);
    if (!result) return false;

    if (result.uci === edge.uci) {
      // Correct.
      if (p.kind === 'test') {
        if (!p.gradedEdges.has(edge.id)) {
          const updated = gradePass(edge);
          const newGraded = new Set(p.gradedEdges);
          newGraded.add(edge.id);
          setPhase({ ...p, gradedEdges: newGraded, sub: 'good-flash', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0 });
          void putEdge(updated);
          setStats(s => ({ ...s, learnPassed: s.learnPassed + 1 }));
        } else {
          setPhase({ ...p, sub: 'good-flash', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0 });
        }
      } else {
        setPhase({ ...p, sub: 'good-flash', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0 });
      }
      return true;
    }

    // Wrong. Decide whether to flash-bad or trigger override prompt.
    const sameAsLast = p.lastWrongUci === result.uci;
    const newSameCount = sameAsLast ? p.sameWrongCount + 1 : 1;
    const newWrongCount = p.wrongCount + 1;

    // Test phase grades on the FIRST wrong attempt at this edge.
    if (p.kind === 'test' && !p.gradedEdges.has(edge.id)) {
      const updated = gradeFail(edge);
      const newGraded = new Set(p.gradedEdges);
      newGraded.add(edge.id);
      setPhase({
        ...p,
        gradedEdges: newGraded, passHadError: true,
        sub: 'bad-flash', lastWrongUci: result.uci, sameWrongCount: newSameCount, wrongCount: newWrongCount,
      });
      void putEdge(updated);
      setStats(s => ({ ...s, learnFailed: s.learnFailed + 1 }));
    } else if (p.kind === 'test') {
      setPhase({ ...p, sub: 'bad-flash', lastWrongUci: result.uci, sameWrongCount: newSameCount, wrongCount: newWrongCount, passHadError: true });
    } else {
      setPhase({ ...p, sub: 'bad-flash', lastWrongUci: result.uci, sameWrongCount: newSameCount, wrongCount: newWrongCount });
    }

    if (newSameCount >= OVERRIDE_AFTER_SAME_WRONG_COUNT) {
      // Trigger override prompt (after the bad-flash settles).
      setTimeout(() => triggerOverride(edge, result.uci, p.kind), BAD_FLASH_MS + 50);
    }
    return true;
  }

  async function triggerOverride(edge: Edge, attemptedUci: string, comesFrom: 'walkthrough' | 'test') {
    const cur = phaseRef.current;
    if (cur.kind !== 'walkthrough' && cur.kind !== 'test') return;
    // Set a transitional state while we evaluate the move.
    setPhase({
      kind: 'override-prompt',
      line: cur.line,
      cursorIdx: cur.cursorIdx,
      mode: cur.mode,
      bestSan: edge.san,
      attemptedSan: '…',
      attemptedUci,
      cpLoss: null,
      resolving: true,
      comesFrom,
    });
    let evalResult;
    try {
      evalResult = await evaluateMoveCpLoss(edge.parentFen, attemptedUci);
    } catch {
      evalResult = { cpLoss: null, best: null, attemptedSan: null };
    }
    const attemptedSan = evalResult.attemptedSan ?? attemptedUci;
    setPhase(p => p.kind !== 'override-prompt' ? p : {
      ...p,
      attemptedSan,
      cpLoss: evalResult.cpLoss,
      resolving: false,
    });
  }

  async function acceptOverride() {
    const p = phaseRef.current;
    if (p.kind !== 'override-prompt') return;
    const edge = p.line.fullPath[p.cursorIdx];
    if (!edge) return;
    setPhase({ ...p, resolving: true });
    const swap = await swapMoveInRepertoire(repertoire.id, edge.parentFen, edge.childFen, {
      from: p.attemptedUci.slice(0, 2),
      to: p.attemptedUci.slice(2, 4),
      promotion: p.attemptedUci.length > 4 ? p.attemptedUci.slice(4) : undefined,
    });
    if (!swap) return;
    setStats(s => ({ ...s, switched: s.switched + 1 }));
    await reload();
    onDataChange();
    const targetYourMoves = Math.max(
      1,
      p.line.fullPath.slice(p.line.generationStartIndex).filter(e => e.mover === repertoire.color).length
    );
    const preservedNewEdges = p.line.newEdges.filter(e => {
      const idx = p.line.fullPath.findIndex(x => x.id === e.id);
      return idx >= p.line.generationStartIndex && idx < p.cursorIdx;
    });
    const nextLine = await continueLearnLine(
      repertoire,
      [...p.line.fullPath.slice(0, p.cursorIdx), swap.edge],
      p.line.generationStartIndex,
      targetYourMoves,
      [...preservedNewEdges, swap.edge],
    );
    setPhase({
      kind: 'walkthrough',
      line: nextLine,
      cursorIdx: p.cursorIdx,
      mode: p.mode,
      sub: 'await',
      lastWrongUci: null,
      sameWrongCount: 0,
      wrongCount: 0,
    });
  }

  function declineOverride() {
    setPhase(p => p.kind !== 'override-prompt' ? p : {
      kind: p.comesFrom,
      line: p.line,
      cursorIdx: p.cursorIdx,
      mode: p.mode,
      sub: 'await',
      lastWrongUci: null,
      sameWrongCount: 0,
      wrongCount: 0,
      ...(p.comesFrom === 'test' ? { gradedEdges: new Set<string>(), passHadError: false, passNumber: 1 } : {}),
    } as Phase);
  }

  function returnToAwait() {
    setPhase(p => {
      if (p.kind === 'walkthrough' || p.kind === 'test') {
        return { ...p, sub: 'await' };
      }
      return p;
    });
  }

  function returnReviewToAwait() {
    setPhase(p => {
      if (p.kind === 'review') return { ...p, sub: 'await' };
      return p;
    });
  }

  function advanceCursor() {
    setPhase(p => {
      if (p.kind !== 'walkthrough' && p.kind !== 'test') return p;
      const next = p.cursorIdx + 1;
      if (next >= p.line.fullPath.length) {
        // End of line.
        if (p.kind === 'walkthrough') {
          // After walkthrough, go to test phase.
          return {
            kind: 'test',
            line: p.line,
            cursorIdx: p.line.generationStartIndex,
            gradedEdges: new Set<string>(),
            passHadError: false,
            passNumber: 1,
            mode: p.mode,
            sub: 'await',
            lastWrongUci: null,
            sameWrongCount: 0,
            wrongCount: 0,
          };
        }
        // Test: maybe replay if errors, else finish line.
        if (p.passHadError) {
          return {
            ...p,
            cursorIdx: p.line.generationStartIndex,
            passHadError: false,
            passNumber: p.passNumber + 1,
            sub: 'await',
            lastWrongUci: null,
            sameWrongCount: 0,
            wrongCount: 0,
          };
        }
        // Done with line.
        setTimeout(() => {
          setStats(s => ({ ...s, linesLearned: s.linesLearned + 1 }));
          finishLine(p.mode);
        }, 0);
        return p;
      }
      return { ...p, cursorIdx: next, sub: 'await', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0 };
    });
  }

  function finishLine(mode: SessionMode) {
    if (mode === 'learn-and-review') {
      void reloadAndEnterReview(mode);
    } else {
      setPhase({ kind: 'done', mode });
    }
  }

  async function reloadAndEnterReview(mode: SessionMode) {
    const fresh = await getEdgesByMover(repertoire.id, repertoire.color);
    const now = new Date();
    const queue = fresh
      .filter(e => isDue(e, now))
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
      .slice(0, REVIEW_QUEUE_CAP);
    if (queue.length === 0) {
      setPhase({ kind: 'done', mode });
      return;
    }
    setPhase({ kind: 'review', queue, idx: 0, mode, sub: 'await', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0 });
  }

  // ---------- Review phase ----------

  async function attemptReviewMove(move: { from: string; to: string; promotion?: string }): Promise<boolean> {
    const p = phaseRef.current;
    if (p.kind !== 'review') return false;
    if (p.sub !== 'await') return false;
    const card = p.queue[p.idx];
    if (!card) return false;
    const result = applyMove(card.parentFen, move);
    if (!result) return false;
    if (result.uci === card.uci) {
      setPhase({ ...p, sub: 'good-flash', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0 });
      const updated = gradePass(card);
      void putEdge(updated);
      setStats(s => ({ ...s, reviewPassed: s.reviewPassed + 1 }));
      return true;
    }
    // Wrong. Apply gradeFail on first wrong only.
    const sameAsLast = p.lastWrongUci === result.uci;
    const newSameCount = sameAsLast ? p.sameWrongCount + 1 : 1;
    const newWrongCount = p.wrongCount + 1;
    if (newSameCount === 1) {
      const updated = gradeFail(card);
      void putEdge(updated);
      setStats(s => ({ ...s, reviewFailed: s.reviewFailed + 1 }));
    }
    setPhase({ ...p, sub: 'bad-flash', lastWrongUci: result.uci, sameWrongCount: newSameCount, wrongCount: newWrongCount });
    if (newSameCount >= OVERRIDE_AFTER_SAME_WRONG_COUNT) {
      // Override prompt for review too.
      setTimeout(() => triggerReviewOverride(card, result.uci), BAD_FLASH_MS + 50);
    }
    return true;
  }

  async function triggerReviewOverride(card: Edge, attemptedUci: string) {
    const p = phaseRef.current;
    if (p.kind !== 'review') return;
    setPhase({
      kind: 'override-prompt',
      line: { fullPath: [card], newEdges: [], generationStartIndex: 0 } as GeneratedLine,
      cursorIdx: 0,
      mode: p.mode,
      bestSan: card.san,
      attemptedSan: '…',
      attemptedUci,
      cpLoss: null,
      resolving: true,
      comesFrom: 'test',
    });
    let evalResult;
    try { evalResult = await evaluateMoveCpLoss(card.parentFen, attemptedUci); } catch { evalResult = { cpLoss: null, best: null, attemptedSan: null }; }
    setPhase(p2 => p2.kind !== 'override-prompt' ? p2 : { ...p2, attemptedSan: evalResult.attemptedSan ?? attemptedUci, cpLoss: evalResult.cpLoss, resolving: false });
  }

  function advanceReviewAfterFlash() {
    setPhase(p => {
      if (p.kind !== 'review') return p;
      const next = p.idx + 1;
      if (next >= p.queue.length) return { kind: 'done', mode: p.mode };
      return { ...p, idx: next, sub: 'await', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0 };
    });
  }

  function handleSkipReview() {
    const p = phaseRef.current;
    if (p.kind !== 'review') return;
    setStats(s => ({ ...s, reviewSkipped: s.reviewSkipped + 1 }));
    setPhase({ ...p, sub: 'good-flash', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0 });
  }

  // ---------- Render ----------

  const orientation: 'white' | 'black' = repertoire.color === 'w' ? 'white' : 'black';

  if (phase.kind === 'setup') {
    return (
      <div className="layout">
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <h3>Start a session — {repertoire.name} ({repertoire.color === 'w' ? 'White' : 'Black'})</h3>
          {genError && <div style={{ color: 'var(--bad)', marginBottom: 8 }} className="small">{genError}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={() => startSession('learn-and-review')}>Learn + Review</button>
            <button onClick={() => startSession('learn-only')}>Learn only</button>
            <button onClick={() => startSession('review-only')}>Review only ({dueCount} due)</button>
          </div>
          <div className="muted small" style={{ marginTop: 12 }}>
            <strong>Learn</strong>: a new line is auto-generated. The walkthrough plays opponent moves and shows arrows for yours; you play your own pieces. Then it's tested without arrows. <strong>Review</strong>: up to 10 oldest-due positions, one at a time.
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === 'generating') {
    const loadingCard = chooseLoadingHistoryCard(loadingHistoryProgress);
    return (
      <div className="layout">
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <h3>Generating a new line from Lichess...</h3>
          {loadingCard && (
            <LoadingHistoryCard
              cardState={loadingCard}
              answerShown={loadingHistoryAnswerShown}
              onToggleAnswer={() => setLoadingHistoryAnswerShown(shown => !shown)}
              onGrade={(knewIt) => void gradeLoadingHistoryCard(loadingCard.id, knewIt)}
            />
          )}
        </div>
      </div>
    );
  }

  if (phase.kind === 'done') {
    return (
      <div className="layout">
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <h3>Session summary</h3>
          {phase.mode !== 'review-only' && (
            <div>
              <h4 style={{ margin: '8px 0 4px' }}>Learn phase</h4>
              {stats.linesLearned > 0 && (
                <div className="success-line"><span className="success-check">✓</span> New line learned</div>
              )}
              <div>Passed: <strong style={{ color: 'var(--good)' }}>{stats.learnPassed}</strong></div>
              <div>Failed: <strong style={{ color: 'var(--bad)' }}>{stats.learnFailed}</strong></div>
              {stats.switched > 0 && <div>Switched moves: <strong>{stats.switched}</strong></div>}
            </div>
          )}
          {phase.mode !== 'learn-only' && (
            <div>
              <h4 style={{ margin: '8px 0 4px' }}>Review phase</h4>
              <div>Passed: <strong style={{ color: 'var(--good)' }}>{stats.reviewPassed}</strong></div>
              <div>Failed: <strong style={{ color: 'var(--bad)' }}>{stats.reviewFailed}</strong></div>
              <div>Skipped: <strong>{stats.reviewSkipped}</strong></div>
            </div>
          )}
          <div className="panel success-summary">
            You now know <strong>{branchCount}</strong> different branch{branchCount === 1 ? '' : 'es'} within {repertoire.name}.
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={() => setPhase({ kind: 'setup' })}>Back to setup</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === 'override-prompt') {
    const isFineAlternative = phase.cpLoss !== null && Math.abs(phase.cpLoss) <= TUNING.evalThresholdPawn * 100;
    const edge = phase.line.fullPath[phase.cursorIdx] ?? phase.line.fullPath[phase.line.fullPath.length - 1];
    const boardFen = edge?.parentFen ?? repertoire.rootFen;
    const sanLineUpToHere = renderSanFromEdges(phase.line.fullPath.slice(0, phase.cursorIdx));
    const sourceEdge = edge ? findSourceEdge(phase.line.fullPath, phase.cursorIdx, repertoire.color) : null;
    return (
      <div className="layout">
        <div>
          <Board
            fen={boardFen}
            orientation={orientation}
            onMove={() => false}
            allowMoves={false}
            arrows={edge ? [{ startSquare: edge.uci.slice(0, 2), endSquare: edge.uci.slice(2, 4), color: 'rgba(74,144,226,0.55)' }] : []}
            size={boardSize}
            animatePositionChange={animateComputerMove}
            resizable
            onSizeChange={onBoardSizeChange}
          />
        </div>
        <div>
          <div className="panel">
            <h3>Line so far</h3>
            <div className="mono small">{sanLineUpToHere || '(start)'}</div>
          </div>
          <SourceGamePanel edge={sourceEdge} line={phase.line.fullPath} color={repertoire.color} />
        </div>
        <div className="modal-backdrop soft">
          <div className="modal">
          <h3>Switch to your move?</h3>
          {phase.resolving ? <div className="muted small">Checking with the engine…</div> : (
            <>
              <div style={{ marginBottom: 8 }}>
                You played <strong className="mono">{phase.attemptedSan}</strong>. The stored move is <strong className="mono">{phase.bestSan}</strong>.
              </div>
              {phase.cpLoss === null ? (
                <div className="muted small">Engine has no eval for this position — can't say which is better.</div>
              ) : isFineAlternative ? (
                <div style={{ color: 'var(--good)' }} className="small">
                  <strong className="mono">{phase.attemptedSan}</strong> loses ~{Math.round(Math.max(0, phase.cpLoss))} cp vs <strong className="mono">{phase.bestSan}</strong>. That's within the threshold — fine alternative.
                </div>
              ) : (
                <div style={{ color: 'var(--warn)' }} className="small">
                  <strong className="mono">{phase.attemptedSan}</strong> loses ~{Math.round(phase.cpLoss)} cp vs <strong className="mono">{phase.bestSan}</strong>. The engine considers it objectively worse.
                </div>
              )}
              <div className="row" style={{ marginTop: 14 }}>
                <button className="primary" onClick={acceptOverride}>Use {phase.attemptedSan} instead</button>
                <button onClick={declineOverride}>Stick with {phase.bestSan}</button>
              </div>
              <div className="muted small" style={{ marginTop: 12 }}>
                Switching keeps this lesson the same length and generates the remaining moves from your choice.
              </div>
            </>
          )}
          </div>
        </div>
      </div>
    );
  }

  // Walkthrough / Test
  if (phase.kind === 'walkthrough' || phase.kind === 'test') {
    const cur = phase.line.fullPath[phase.cursorIdx] ?? phase.line.fullPath[phase.line.fullPath.length - 1];
    const isYour = cur.mover === repertoire.color;
    const premoveTarget = getPremoveTarget(phase, repertoire.color);
    const showHintArrow = isYour && phase.sub === 'await' && (
      phase.kind === 'walkthrough' || phase.wrongCount >= HINT_AFTER_WRONG_COUNT
    );
    const arrows = [
      ...(showHintArrow
        ? [{ startSquare: cur.uci.slice(0, 2), endSquare: cur.uci.slice(2, 4), color: 'rgba(74,144,226,0.9)' }]
        : []),
      ...(queuedPremove
        ? [{ startSquare: queuedPremove.from, endSquare: queuedPremove.to, color: 'rgba(240,180,45,0.9)' }]
        : []),
    ];
    // After good-flash the move has been played; show the resulting position briefly.
    const boardFen = phase.sub === 'good-flash' ? cur.childFen : cur.parentFen;
    const flashClass = phase.sub === 'good-flash' ? 'board-flash-good' : phase.sub === 'bad-flash' ? 'board-flash-bad' : undefined;
    const turn = turnAt(cur.parentFen);
    const pillStates = computePillStates(phase);
    const sanLineUpToHere = renderSanFromEdges(phase.line.fullPath.slice(0, phase.cursorIdx));
    const lastMove = phase.sub === 'good-flash' ? cur : phase.line.fullPath[phase.cursorIdx - 1] ?? null;
    const sourceEdge = findSourceEdge(phase.line.fullPath, phase.cursorIdx, repertoire.color);

    return (
      <div className="layout">
        <div>
          <Board
            fen={boardFen}
            orientation={orientation}
            onMove={(m) => {
              if (phase.sub === 'await' && isYour) {
                const valid = applyMove(cur.parentFen, m);
                if (!valid) return false;
                void attemptUserMove(m);
                return true;
              }
              if (premoveTarget && applyMove(premoveTarget.parentFen, m)) {
                setQueuedPremove(m);
              }
              return false;
            }}
            allowMoves={(phase.sub === 'await' && isYour) || !!premoveTarget}
            allowedDragColor={repertoire.color}
            arrows={arrows}
            highlights={lastMove ? lastMoveHighlights(lastMove) : undefined}
            flashClass={flashClass}
            size={boardSize}
            resizable
            onSizeChange={onBoardSizeChange}
          />
          <ProgressPills states={pillStates} />
          <div className="row" style={{ marginTop: 10 }}>
            <span className="muted small">
              {phase.kind === 'walkthrough' ? 'Walkthrough' : `Test pass ${phase.passNumber}`} · {turn === 'w' ? 'White' : 'Black'} to move
            </span>
            <span className="spacer" />
            <button className="danger" onClick={() => setPhase({ kind: 'done', mode: phase.mode })}>End session</button>
          </div>
        </div>
        <div>
          {phase.kind === 'walkthrough' && isYour && phase.sub === 'await' && (
            <div className="train-feedback" style={{ background: 'transparent', borderColor: 'var(--accent)', color: 'var(--text)' }}>
              Play <strong className="mono">{cur.san}</strong> (follow the arrow).
            </div>
          )}
          {phase.kind === 'walkthrough' && !isYour && phase.sub === 'await' && (
            <div className="train-feedback" style={{ background: 'transparent', borderColor: 'var(--border)', color: 'var(--text-dim)' }}>
              Opponent plays <span className="mono">{cur.san}</span>…
            </div>
          )}
          {phase.kind === 'test' && isYour && phase.sub === 'await' && (
            <div className="train-feedback" style={{ background: 'transparent', borderColor: 'var(--border)', color: 'var(--text)' }}>
              {phase.wrongCount >= HINT_AFTER_WRONG_COUNT ? (
                <>Play <strong className="mono">{cur.san}</strong>.</>
              ) : (
                'Play the move you just learned.'
              )}
            </div>
          )}
          {phase.kind === 'test' && !isYour && phase.sub === 'await' && (
            <div className="train-feedback" style={{ background: 'transparent', borderColor: 'var(--border)', color: 'var(--text-dim)' }}>
              Opponent plays <span className="mono">{cur.san}</span>…
            </div>
          )}
          <div className="panel">
            <h3>Line so far</h3>
            <div className="mono small">{sanLineUpToHere || '(start)'}</div>
          </div>
          <SourceGamePanel edge={sourceEdge} line={phase.line.fullPath} color={repertoire.color} />
          <div className="panel">
            <h3>Session</h3>
            <div className="small">
              Learn — Passed {stats.learnPassed} · Failed {stats.learnFailed}
              {stats.switched > 0 && ` · Switched ${stats.switched}`}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === 'review') {
    const card = phase.queue[phase.idx];
    if (!card) return null;
    const boardFen = phase.sub === 'good-flash' ? card.childFen : card.parentFen;
    const flashClass = phase.sub === 'good-flash' ? 'board-flash-good' : phase.sub === 'bad-flash' ? 'board-flash-bad' : undefined;
    const lastMoveHighlightsForReview = phase.sub === 'good-flash' ? lastMoveHighlights(card) : undefined;
    return (
      <div className="layout">
        <div>
          <Board
            fen={boardFen}
            orientation={orientation}
            onMove={(m) => {
              if (phase.sub !== 'await') return false;
              const valid = applyMove(card.parentFen, m);
              if (!valid) return false;
              void attemptReviewMove(m);
              return true;
            }}
            allowMoves={phase.sub === 'await'}
            allowedDragColor={repertoire.color}
            arrows={phase.sub === 'await' && phase.wrongCount >= HINT_AFTER_WRONG_COUNT
              ? [{ startSquare: card.uci.slice(0, 2), endSquare: card.uci.slice(2, 4), color: 'rgba(74,144,226,0.9)' }]
              : []}
            highlights={lastMoveHighlightsForReview}
            flashClass={flashClass}
            size={boardSize}
            resizable
            onSizeChange={onBoardSizeChange}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <span className="muted small">Review {phase.idx + 1} / {phase.queue.length}</span>
            <span className="spacer" />
            <button onClick={handleSkipReview} disabled={phase.sub !== 'await'}>Skip</button>
            <button className="danger" onClick={() => setPhase({ kind: 'done', mode: phase.mode })}>End</button>
          </div>
        </div>
        <div>
          {phase.sub === 'await' && (
            <div className="train-feedback" style={{ background: 'transparent', borderColor: 'var(--border)', color: 'var(--text)' }}>
              Play the stored move for this position.
            </div>
          )}
          <div className="panel">
            <h3>Card stats</h3>
            <SourceGameDetails edge={card} />
            <div className="small">
              <div>Reps: {card.reps} · Lapses: {card.lapses}</div>
              <div>Ease: {card.ease.toFixed(2)} · Interval: {card.intervalDays}d</div>
            </div>
          </div>
          <div className="panel">
            <h3>Session</h3>
            <div className="small">Review — Passed {stats.reviewPassed} · Failed {stats.reviewFailed} · Skipped {stats.reviewSkipped}</div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

function emptyStats(): SessionStats {
  return { learnPassed: 0, learnFailed: 0, reviewPassed: 0, reviewFailed: 0, reviewSkipped: 0, switched: 0, linesLearned: 0 };
}

function SourceGamePanel({ edge, line, color }: { edge: Edge | null; line: Edge[]; color: Repertoire['color'] }) {
  const userEdges = line.filter(e => e.mover === color);
  const sourcedEdges = userEdges.filter(e => e.sourcePlayerName || e.sourceGameName);
  return (
    <div className="panel source-game-panel">
      <h3>Line source</h3>
      {edge?.sourcePlayerName || edge?.sourceGameName ? (
        <SourceGameDetails edge={edge} />
      ) : sourcedEdges.length > 0 ? (
        <>
          <div className="muted small">No named source game for the current move. Earlier sourced move:</div>
          <SourceGameDetails edge={sourcedEdges[sourcedEdges.length - 1]} />
        </>
      ) : (
        <div className="muted small">
          This line was not generated from a named player game, or it was created before source-game tracking was added.
        </div>
      )}
    </div>
  );
}

function SourceGameDetails({ edge }: { edge: Edge | null }) {
  if (!edge?.sourcePlayerName && !edge?.sourceGameName) return null;
  return (
    <div className="source-game-details">
      {edge.sourcePlayerName && <div><strong>{edge.sourcePlayerName}</strong></div>}
      {edge.sourceGameName && <div className="small source-game-name">{edge.sourceGameName}</div>}
      {edge.sourceNet !== undefined && (
        <div className="muted small source-game-score">
          {edge.sourceWins ?? 0}W {edge.sourceDraws ?? 0}D {edge.sourceLosses ?? 0}L · net +{edge.sourceNet}
        </div>
      )}
    </div>
  );
}

function findSourceEdge(path: Edge[], cursorIdx: number, color: Repertoire['color']): Edge | null {
  const maxIdx = Math.min(cursorIdx, path.length - 1);
  for (let i = maxIdx; i >= 0; i--) {
    const edge = path[i];
    if (edge?.mover === color && (edge.sourcePlayerName || edge.sourceGameName)) return edge;
  }
  return null;
}

function chooseLoadingHistoryCard(progressByCard: ProgressByCard): HistoryCardState | null {
  const now = new Date();
  const cards = buildHistoryCardStates(progressByCard, now);
  if (cards.length === 0) return null;
  return cards
    .sort((a, b) => {
      const dueDelta = Number(isHistoryDue(b.progress, now)) - Number(isHistoryDue(a.progress, now));
      if (dueDelta !== 0) return dueDelta;
      const newDelta = Number(!progressByCard[b.id]) - Number(!progressByCard[a.id]);
      if (newDelta !== 0) return newDelta;
      return a.progress.dueAt.localeCompare(b.progress.dueAt);
    })[0];
}

function LoadingHistoryCard({ cardState, answerShown, onToggleAnswer, onGrade }: {
  cardState: HistoryCardState;
  answerShown: boolean;
  onToggleAnswer: () => void;
  onGrade: (knewIt: boolean) => void;
}) {
  const [before, after] = cardState.card.prompt.split('{{C1}}');
  return (
    <div className="cloze-card">
      <div className="muted small">While Lichess thinks</div>
      <div className="cloze-prompt">
        {before}
        <button className={'cloze-blank history-answer' + (answerShown ? ' revealed' : '')} onClick={onToggleAnswer} title="Click to pin answer">
          {cardState.card.answer}
        </button>
        {after}
      </div>
      <div className="row history-actions">
        <button className="primary" onClick={() => onGrade(true)}>Knew it</button>
        <button onClick={() => onGrade(false)}>Couldn't pull it</button>
      </div>
    </div>
  );
}

function renderSanFromEdges(edges: Edge[]): string {
  const out: string[] = [];
  let moveNum = 1;
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

function countBranches(rootFen: string, edges: Edge[]): number {
  if (edges.length === 0) return 0;
  const byParent = new Map<string, Edge[]>();
  for (const e of edges) {
    const list = byParent.get(e.parentFen) ?? [];
    list.push(e);
    byParent.set(e.parentFen, list);
  }
  let leaves = 0;
  const stack = [rootFen];
  const seen = new Set<string>();
  while (stack.length) {
    const fen = stack.pop()!;
    if (seen.has(fen)) continue;
    seen.add(fen);
    const children = byParent.get(fen) ?? [];
    if (children.length === 0 && fen !== rootFen) {
      leaves++;
      continue;
    }
    for (const child of children) stack.push(child.childFen);
  }
  return leaves;
}

function getPremoveTarget(phase: Phase, color: Repertoire['color']): Edge | null {
  if (phase.kind !== 'walkthrough' && phase.kind !== 'test') return null;
  if (phase.sub === 'await') {
    const cur = phase.line.fullPath[phase.cursorIdx];
    const next = phase.line.fullPath[phase.cursorIdx + 1];
    return cur && cur.mover !== color && next?.mover === color ? next : null;
  }
  if (phase.sub === 'good-flash') {
    const next = phase.line.fullPath[phase.cursorIdx + 1];
    const afterNext = phase.line.fullPath[phase.cursorIdx + 2];
    if (next?.mover === color) return next;
    if (next && next.mover !== color && afterNext?.mover === color) return afterNext;
  }
  return null;
}

function ProgressPills({ states }: { states: PillState[] }) {
  if (states.length === 0) return null;
  return (
    <div className="progress-pills">
      {states.map((s, i) => (
        <div key={i} className={'pill ' + s} />
      ))}
    </div>
  );
}

function computePillStates(phase: Phase): PillState[] {
  if (phase.kind !== 'walkthrough' && phase.kind !== 'test') return [];
  // Pills represent the user's NEW your-color moves (i.e., newEdges that are your color).
  const yourNewEdges = phase.line.newEdges.filter(e => e.mover === phase.line.fullPath[phase.line.generationStartIndex]?.mover);
  // The cursor tells us which of those is currently being interacted with.
  const cur = phase.line.fullPath[phase.cursorIdx];
  return yourNewEdges.map(e => {
    if (cur && e.id === cur.id) return 'current';
    // Did the cursor pass it already?
    const idxOfE = phase.line.fullPath.findIndex(x => x.id === e.id);
    if (idxOfE >= 0 && idxOfE < phase.cursorIdx) {
      // Look at gradedEdges for failure detection.
      if (phase.kind === 'test' && phase.gradedEdges.has(e.id)) {
        // We don't have a "failed" set on the phase; derive: if reps was incremented (pass) vs lapses (fail).
        // Fallback: just mark done. TODO: track per-edge first-attempt outcome.
      }
      return 'done';
    }
    return 'pending';
  });
}
