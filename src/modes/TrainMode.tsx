import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Board } from '../components/Board';
import { applyMove, computeOpeningFen, turnAt, STARTING_FEN_NORM } from '../lib/chess';
import { findOpening } from '../lib/openings';
import {
  continueLearnLine,
  generateLearnLine,
  getPrepMoveWarning,
  getPrepOpponentBranches,
  rebuildFrontierQueue,
  savePrepStopFrontier,
  evaluateMoveCpLoss,
  pvCpForColor,
  TUNING,
  type GeneratedLine,
  type GenerationTrace,
  type PrepMoveWarning,
  type PrepOpponentBranch,
} from '../lib/autosuggest';
import { fetchCloudEval } from '../lib/lichess';
import { addMovesToRepertoire, CURATED_OPENINGS, getEdge, getEdgesByMover, getEdgesForRepertoire, getEdgesFromParent, getFrontiersForRepertoire, markCuratedOpeningScaffolds, playMoveInRepertoire, putEdge, swapMoveInRepertoire } from '../lib/storage';
import { gradeFail, gradeLearnPass, gradePass, isDue } from '../lib/srs';
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
import { useTrainingPreferences } from '../lib/trainingPreferences';
import type { Edge, FrontierCandidate, NormFen, Repertoire } from '../types';

type SessionMode = 'learn-and-review' | 'learn-only' | 'review-only';
type Sub = 'await' | 'bad-flash' | 'good-flash';
type PillState = 'pending' | 'current' | 'done' | 'failed';

interface PrepBranch extends PrepOpponentBranch {
  path: Edge[];
  depth: number;
  weight: number;
}

interface PrepMapStats {
  movesMapped: number;
  frontiersCreated: number;
  branchesExplored: number;
  deepestPly: number;
}

interface PrepPendingMove {
  from: string;
  to: string;
  promotion?: string;
  san: string;
  uci: string;
}

type Phase =
  | { kind: 'setup' }
  | { kind: 'generating'; mode: SessionMode }
  | { kind: 'line-ready'; line: GeneratedLine; mode: SessionMode }
  | { kind: 'prep-map'; cursorFen: NormFen; path: Edge[]; queue: PrepBranch[]; stats: PrepMapStats; loading: boolean; message: string | null }
  | { kind: 'prep-confirm'; state: Extract<Phase, { kind: 'prep-map' }>; move: PrepPendingMove; warning: PrepMoveWarning }
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

const OPP_AUTOPLAY_DELAY_MS = 80;
const BAD_FLASH_MS = 110;
const HINT_AFTER_WRONG_COUNT = 1;
const OVERRIDE_AFTER_SAME_WRONG_COUNT = 3;

export interface TrainModeProps {
  repertoire: Repertoire;
  onDataChange: () => void;
  refreshKey: number;
  boardSize: number;
  onBoardSizeChange: (size: number) => void;
}

export function TrainMode({ repertoire, onDataChange, refreshKey, boardSize, onBoardSizeChange }: TrainModeProps) {
  const { preferences: trainingPreferences } = useTrainingPreferences();
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const [stats, setStats] = useState<SessionStats>(emptyStats());
  const [allEdges, setAllEdges] = useState<Edge[]>([]);
  const [genError, setGenError] = useState<string | null>(null);
  const [genTrace, setGenTrace] = useState<string[]>([]);
  const [genTraceCopyStatus, setGenTraceCopyStatus] = useState<string | null>(null);
  const [frontierQueue, setFrontierQueue] = useState<FrontierCandidate[]>([]);
  const [frontierCopyStatus, setFrontierCopyStatus] = useState<string | null>(null);
  const [rebuildingFrontiers, setRebuildingFrontiers] = useState(false);
  const [prepOpeningKey, setPrepOpeningKey] = useState<string>(() => repertoire.openingKey ?? '');
  const [queuedPremove, setQueuedPremove] = useState<{ from: string; to: string; promotion?: string } | null>(null);
  const [animateComputerMove, setAnimateComputerMove] = useState(false);
  const [loadingHistoryProgress, setLoadingHistoryProgress] = useState<ProgressByCard>({});
  const [loadingHistoryAnswerShown, setLoadingHistoryAnswerShown] = useState(false);

  // "Two in the queue": pre-generate up to 2 lines in the background while the user trains,
  // so subsequent Learn sessions start instantly without a loading screen.
  const preGenRef = useRef<{ queue: GeneratedLine[]; abort: AbortController | null }>({ queue: [], abort: null });
  const repertoireRef = useRef(repertoire);
  repertoireRef.current = repertoire;

  const kickPreGen = useCallback(() => {
    if (preGenRef.current.abort) return; // already running
    const controller = new AbortController();
    preGenRef.current.abort = controller;
    void (async () => {
      try {
        while (preGenRef.current.queue.length < 2 && !controller.signal.aborted) {
          const line = await generateLearnLine(repertoireRef.current, trainingPreferences.learnLineDepth, controller.signal);
          if (!line || controller.signal.aborted) break;
          preGenRef.current.queue = [...preGenRef.current.queue, line];
        }
      } catch {
        // Best-effort — silent failure keeps the session working normally.
      } finally {
        preGenRef.current.abort = null;
      }
    })();
  }, [trainingPreferences.learnLineDepth]);

  const reload = useCallback(async () => {
    const [es, frontiers] = await Promise.all([
      getEdgesForRepertoire(repertoire.id),
      getFrontiersForRepertoire(repertoire.id),
    ]);
    setAllEdges(es);
    setFrontierQueue(frontiers);
  }, [repertoire.id]);

  useEffect(() => { void reload(); }, [reload, refreshKey]);
  useEffect(() => {
    // Clear pre-gen queue and abort any in-flight generation when switching repertoires.
    preGenRef.current.abort?.abort();
    preGenRef.current = { queue: [], abort: null };
    setPhase({ kind: 'setup' }); setStats(emptyStats()); setQueuedPremove(null);
    setFrontierCopyStatus(null);
    setPrepOpeningKey(repertoire.openingKey ?? '');
  }, [repertoire.id]);
  useEffect(() => () => { preGenRef.current.abort?.abort(); }, []);
  useEffect(() => {
    preGenRef.current.abort?.abort();
    preGenRef.current = { queue: [], abort: null };
  }, [trainingPreferences.learnLineDepth]);
  useEffect(() => {
    (async () => setLoadingHistoryProgress(await getHistoryProgress()))();
  }, [refreshKey]);

  const dueCount = useMemo(() => {
    const now = new Date();
    return allEdges.filter(e => isTrainableEdge(e, repertoire.color) && isDue(e, now)).length;
  }, [allEdges, repertoire.color]);

  const branchCount = useMemo(() => countBranches(repertoire.rootFen, allEdges), [repertoire.rootFen, allEdges]);
  const prepOpeningOptions = useMemo(
    () => CURATED_OPENINGS.filter(opening => opening.color === repertoire.color),
    [repertoire.color]
  );
  const selectedPrepOpening = useMemo(
    () => prepOpeningOptions.find(opening => opening.key === prepOpeningKey) ?? null,
    [prepOpeningKey, prepOpeningOptions]
  );

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
    if (prevEdge && !isTrainableEdge(prevEdge, repertoire.color) && curEdge && isTrainableEdge(curEdge, repertoire.color) && phase.cursorIdx > prev.cursorIdx) {
      setAnimateComputerMove(true);
      const timer = setTimeout(() => setAnimateComputerMove(false), 120);
      return () => clearTimeout(timer);
    }
  }, [phase, repertoire.color]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (phase.kind === 'walkthrough' || phase.kind === 'test') {
      const cur = phase.line.fullPath[phase.cursorIdx];
      if (phase.sub === 'await' && cur && !isTrainableEdge(cur, repertoire.color)) {
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
    if (!cur || !isTrainableEdge(cur, repertoire.color)) return;
    setQueuedPremove(null); // eslint-disable-line react-hooks/set-state-in-effect
    void attemptUserMove(queuedPremove);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, queuedPremove, repertoire.color]);

  // ---------- Session entry ----------

  async function startSession(mode: SessionMode) {
    setStats(emptyStats());
    setGenError(null);
    setGenTrace([]);
    setGenTraceCopyStatus(null);
    const traceStartedAt = performance.now();
    let traceIndex = 0;
    const trace: GenerationTrace = (message) => {
      const elapsed = ((performance.now() - traceStartedAt) / 1000).toFixed(2).padStart(6, ' ');
      traceIndex += 1;
      const line = `${String(traceIndex).padStart(3, '0')} +${elapsed}s ${message}`;
      setGenTrace(prev => [...prev, line]);
    };
    trace(`Session requested: mode=${mode}, repertoire="${repertoire.name}", color=${repertoire.color}, root=${repertoire.rootFen}`);
    if (mode === 'review-only') {
      trace('Review-only mode selected; line generation skipped.');
      void enterReviewPhase(mode);
      return;
    }
    setLoadingHistoryAnswerShown(false);

    // Use a pre-generated line if one is ready — no loading screen needed.
    if (preGenRef.current.queue.length > 0) {
      trace(`Using pre-generated line from queue; queuedLines=${preGenRef.current.queue.length}.`);
      const line = preGenRef.current.queue[0];
      preGenRef.current.queue = preGenRef.current.queue.slice(1);
      kickPreGen(); // refill the queue
      await reload();
      onDataChange();
      trace(`Pre-generated line ready: fullPath=${line.fullPath.length}, newEdges=${line.newEdges.length}, generationStartIndex=${line.generationStartIndex}.`);
      setPhase({ kind: 'line-ready', line, mode });
      return;
    }

    setPhase({ kind: 'generating', mode });
    let line: GeneratedLine | null;
    try {
      line = await generateLearnLine(repertoire, trainingPreferences.learnLineDepth, undefined, trace);
    } catch (e) {
      trace(`Generation threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      setGenError(e instanceof Error ? e.message : String(e));
      setPhase({ kind: 'setup' });
      return;
    }
    if (!line) {
      trace('Generation returned null.');
      setGenError('Could not generate a line from this repertoire yet. Chesski could not find a frontier or a usable opponent continuation.');
      await reload();
      setPhase({ kind: 'setup' });
      return;
    }
    await reload();
    onDataChange();
    trace(`Generation succeeded: fullPath=${line.fullPath.length}, newEdges=${line.newEdges.length}, generationStartIndex=${line.generationStartIndex}.`);
    setPhase({ kind: 'line-ready', line, mode });
  }

  async function copyGenerationTrace() {
    const text = genTrace.join('\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setGenTraceCopyStatus('Copied');
    } catch {
      setGenTraceCopyStatus('Copy failed; select the text below');
    }
  }

  async function refreshFrontierQueue() {
    setRebuildingFrontiers(true);
    setFrontierCopyStatus(null);
    try {
      await rebuildFrontierQueue(repertoire, undefined, (message) => {
        setGenTrace(prev => [...prev, `frontier refresh: ${message}`]);
      });
      await reload();
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setRebuildingFrontiers(false);
    }
  }

  async function copyFrontierQueue() {
    const text = frontierQueue.map((frontier, idx) => [
      `${idx + 1}. ${frontier.status.toUpperCase()} ${frontier.san} (${frontier.uci})`,
      `source=${frontier.source}`,
      `weight=${frontier.weight.toFixed(5)}`,
      `games=${frontier.games}`,
      `popularity=${frontier.popularityFraction.toFixed(3)}`,
      `parentFen=${frontier.parentFen}`,
      `childFen=${frontier.childFen}`,
      `reason=${frontier.lastReason ?? ''}`,
    ].join(' | ')).join('\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setFrontierCopyStatus('Copied');
    } catch {
      setFrontierCopyStatus('Copy failed');
    }
  }

  async function startPrepMap() {
    preGenRef.current.abort?.abort();
    preGenRef.current = { queue: [], abort: null };
    setGenError(null);
    setGenTrace([]);
    setFrontierCopyStatus(null);
    const prepared = await preparePrepOpeningStart();
    if (!prepared) return;
    const initial: Extract<Phase, { kind: 'prep-map' }> = {
      kind: 'prep-map',
      cursorFen: prepared.cursorFen,
      path: prepared.path,
      queue: [],
      stats: { ...emptyPrepStats(), deepestPly: prepared.path.length },
      loading: true,
      message: `Mapping ${prepared.name}. Finding the first opponent branch...`,
    };
    setPhase(initial);
    await advancePrepMap(initial);
  }

  async function preparePrepOpeningStart(): Promise<{ cursorFen: NormFen; path: Edge[]; name: string } | null> {
    const opening = selectedPrepOpening;
    if (!opening) return { cursorFen: repertoire.rootFen, path: [], name: repertoire.name };
    const openingFen = computeOpeningFen(opening.moves);

    if (repertoire.rootFen !== STARTING_FEN_NORM && repertoire.rootFen !== openingFen) {
      setGenError(`"${repertoire.name}" starts from a different opening position. To map ${opening.name} inside a multi-opening repertoire, choose a main repertoire that starts from the normal initial position.`);
      return null;
    }

    if (repertoire.rootFen === STARTING_FEN_NORM) {
      try {
        await addMovesToRepertoire(repertoire, opening.moves, { scaffoldPlyCount: opening.moves.length });
        await markCuratedOpeningScaffolds(repertoire);
      } catch (e) {
        setGenError(e instanceof Error ? e.message : String(e));
        return null;
      }
    }

    const path: Edge[] = [];
    let cursorFen = repertoire.rootFen;
    if (cursorFen === STARTING_FEN_NORM) {
      for (const move of opening.moves) {
        const applied = applyMove(cursorFen, move);
        if (!applied) break;
        const edge = await getEdge(repertoire.id, cursorFen, applied.fen);
        if (edge) path.push(edge);
        cursorFen = applied.fen;
      }
    }
    return { cursorFen: openingFen, path, name: opening.name };
  }

  async function enqueuePrepBranches(state: Extract<Phase, { kind: 'prep-map' }>): Promise<PrepBranch[]> {
    if (turnAt(state.cursorFen) === repertoire.color) return state.queue;
    try {
      const branches = await getPrepOpponentBranches(state.cursorFen);
      const existingKeys = new Set(state.queue.map(prepBranchKey));
      const next = [...state.queue];
      for (const branch of branches) {
        const key = `${branch.parentFen}::${branch.uci}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        next.push({
          ...branch,
          path: state.path,
          depth: state.path.length,
          weight: branch.popularityFraction,
        });
      }
      return next;
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
      return state.queue;
    }
  }

  async function advancePrepMap(rawState: Extract<Phase, { kind: 'prep-map' }>) {
    let state = { ...rawState, loading: true };
    let queue = await enqueuePrepBranches(state);
    for (let attempts = 0; attempts < 80; attempts++) {
      const selected = choosePrepBranch(queue);
      if (!selected) {
        setPhase({
          ...state,
          queue: [],
          loading: false,
          message: 'Prep map complete for the current popularity threshold.',
        });
        await reload();
        return;
      }
      queue = queue.filter(branch => prepBranchKey(branch) !== prepBranchKey(selected));
      const played = await playMoveInRepertoire(repertoire.id, selected.parentFen, {
        from: selected.uci.slice(0, 2),
        to: selected.uci.slice(2, 4),
        promotion: selected.uci.length > 4 ? selected.uci.slice(4) : undefined,
      });
      if (!played) continue;
      const opponentPath = [...selected.path, played.edge];
      const stats = {
        ...state.stats,
        branchesExplored: state.stats.branchesExplored + 1,
        deepestPly: Math.max(state.stats.deepestPly, opponentPath.length),
      };
      const storedReplies = (await getEdgesFromParent(repertoire.id, played.edge.childFen))
        .filter(edge => edge.mover === repertoire.color && !edge.isScaffold);
      if (storedReplies.length > 0) {
        const reply = storedReplies[0];
        const followed: Extract<Phase, { kind: 'prep-map' }> = {
          kind: 'prep-map',
          cursorFen: reply.childFen,
          path: [...opponentPath, reply],
          queue,
          stats: { ...stats, deepestPly: Math.max(stats.deepestPly, opponentPath.length + 1) },
          loading: true,
          message: `Following stored response ${reply.san}.`,
        };
        state = followed;
        queue = await enqueuePrepBranches(followed);
        continue;
      }
      setPhase({
        kind: 'prep-map',
        cursorFen: played.edge.childFen,
        path: opponentPath,
        queue,
        stats,
        loading: false,
        message: `Opponent played ${played.edge.san}. Show Chesski your prep, or press Not sure.`,
      });
      await reload();
      return;
    }
    setPhase({ ...state, queue, loading: false, message: 'Prep map paused after a long branch search.' });
  }

  function attemptPrepMove(move: { from: string; to: string; promotion?: string }): boolean {
    const p = phaseRef.current;
    if (p.kind !== 'prep-map') return false;
    if (p.loading || turnAt(p.cursorFen) !== repertoire.color) return false;
    const applied = applyMove(p.cursorFen, move);
    if (!applied || applied.mover !== repertoire.color) return false;
    const pending: PrepPendingMove = { ...move, san: applied.san, uci: applied.uci };
    const stableState = { ...p, loading: false };
    setPhase({ ...p, loading: true, message: `Checking ${applied.san} in the database...` });
    void (async () => {
      try {
        const warning = await getPrepMoveWarning(p.cursorFen, applied.uci, repertoire.color);
        if (warning) {
          setPhase({ kind: 'prep-confirm', state: stableState, move: pending, warning });
          return;
        }
      } catch (e) {
        setGenError(e instanceof Error ? e.message : String(e));
      }
      await commitPrepMove(stableState, pending);
    })();
    return true;
  }

  async function commitPrepMove(state: Extract<Phase, { kind: 'prep-map' }>, move: PrepPendingMove) {
    const played = await playMoveInRepertoire(repertoire.id, state.cursorFen, move);
    if (!played) {
      setPhase({ ...state, loading: false, message: `Could not store ${move.san}. Try another move.` });
      return;
    }
    const nextState: Extract<Phase, { kind: 'prep-map' }> = {
      kind: 'prep-map',
      cursorFen: played.edge.childFen,
      path: [...state.path, played.edge],
      queue: state.queue,
      stats: {
        ...state.stats,
        movesMapped: state.stats.movesMapped + (played.edgeCreated ? 1 : 0),
        deepestPly: Math.max(state.stats.deepestPly, state.path.length + 1),
      },
      loading: true,
      message: `Stored ${played.edge.san}. Finding the closest related branch...`,
    };
    await reload();
    onDataChange();
    await advancePrepMap(nextState);
  }

  async function stopPrepHere(stateOverride?: Extract<Phase, { kind: 'prep-map' }>) {
    const p = stateOverride ?? phaseRef.current;
    if (p.kind !== 'prep-map') return;
    if (turnAt(p.cursorFen) !== repertoire.color) {
      await advancePrepMap({ ...p, loading: true, message: 'Skipping to the next branch...' });
      return;
    }
    const saved = await savePrepStopFrontier(repertoire, p.path, p.cursorFen);
    const nextStats = {
      ...p.stats,
      frontiersCreated: p.stats.frontiersCreated + (saved ? 1 : 0),
      deepestPly: Math.max(p.stats.deepestPly, p.path.length),
    };
    await reload();
    onDataChange();
    await advancePrepMap({
      ...p,
      stats: nextStats,
      loading: true,
      message: saved ? 'Frontier stored. Finding the closest related branch...' : 'No opponent move led here, so no frontier was stored.',
    });
  }

  function studyPreparedLine(line: GeneratedLine, mode: SessionMode) {
    setLoadingHistoryAnswerShown(false);
    setPhase({
      kind: 'walkthrough', line, cursorIdx: line.generationStartIndex, mode,
      sub: 'await', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0,
    });
    // Start pre-generating the next line(s) while the user trains this one.
    kickPreGen();
  }

  async function gradeLoadingHistoryCard(cardId: string, knewIt: boolean) {
    const current = loadingHistoryProgress[cardId] ?? freshHistoryProgress();
    const updated = { ...loadingHistoryProgress, [cardId]: gradeHistory(current, knewIt ? 'known' : 'unknown') };
    setLoadingHistoryProgress(updated);
    setLoadingHistoryAnswerShown(false);
    await saveHistoryProgress(updated);
    onDataChange();
  }

  async function enterReviewPhase(mode: SessionMode) {
    const fresh = await getEdgesByMover(repertoire.id, repertoire.color);
    const queue = buildReviewQueue(fresh, mode === 'learn-and-review', trainingPreferences.reviewSessionLength);
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
    if (!edge || !isTrainableEdge(edge, repertoire.color)) return false;
    const result = applyMove(edge.parentFen, move);
    if (!result) return false;

    if (result.uci === edge.uci) {
      // Correct.
      if (p.kind === 'test') {
        setPhase({ ...p, sub: 'good-flash', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0 });
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
      p.line.fullPath.slice(p.line.generationStartIndex).filter(e => isTrainableEdge(e, repertoire.color)).length
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
          void completeTestLine(p);
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
    const queue = buildReviewQueue(fresh, mode === 'learn-and-review', trainingPreferences.reviewSessionLength);
    if (queue.length === 0) {
      setPhase({ kind: 'done', mode });
      return;
    }
    setPhase({ kind: 'review', queue, idx: 0, mode, sub: 'await', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0 });
  }

  async function completeTestLine(p: Extract<Phase, { kind: 'test' }>) {
    const learnedEdges = p.line.newEdges.filter(e => isTrainableEdge(e, repertoire.color));
    for (const edge of learnedEdges) {
      const latest = await getEdge(repertoire.id, edge.parentFen, edge.childFen);
      await putEdge(gradeLearnPass(latest ?? edge));
    }
    await reload();
    onDataChange();
    setRebuildingFrontiers(true);
    try {
      await rebuildFrontierQueue(repertoire);
      await reload();
    } finally {
      setRebuildingFrontiers(false);
    }
    setStats(s => ({ ...s, learnPassed: s.learnPassed + learnedEdges.length, linesLearned: s.linesLearned + 1 }));
    finishLine(p.mode);
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
      setPhase({ ...p, sub: 'good-flash', lastWrongUci: null, sameWrongCount: 0 });
      if (p.wrongCount === 0) {
        const updated = gradePass(card);
        void putEdge(updated);
        setStats(s => ({ ...s, reviewPassed: s.reviewPassed + 1 }));
      }
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
      if (p.wrongCount > 0) {
        const card = p.queue[p.idx];
        if (!card) return { kind: 'done', mode: p.mode };
        const queue = [...p.queue.slice(0, p.idx), ...p.queue.slice(p.idx + 1), card];
        if (queue.length === 0) return { kind: 'done', mode: p.mode };
        const idx = Math.min(p.idx, queue.length - 1);
        return { ...p, queue, idx, sub: 'await', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0 };
      }
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
  const openingPreamble = useMemo(() => {
    if (repertoire.rootFen === STARTING_FEN_NORM || !repertoire.openingKey) return null;
    const opening = findOpening(repertoire.openingKey);
    if (!opening) return null;
    return formatOpeningMoves(opening.moves);
  }, [repertoire.rootFen, repertoire.openingKey]);

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
            <button onClick={() => void startPrepMap()}>Map my prep</button>
          </div>
          <div className="muted small" style={{ marginTop: 12 }}>
            <strong>Learn</strong>: a new line is auto-generated. The walkthrough plays opponent moves and shows arrows for yours; you play your own pieces. Then it's tested without arrows. <strong>Review</strong>: up to {trainingPreferences.reviewSessionLength} oldest-due positions, one at a time.
          </div>
          <div className="prep-opening-picker">
            <label className="small muted" htmlFor="prep-opening-select">Prep mapping starts from</label>
            <select
              id="prep-opening-select"
              value={prepOpeningKey}
              onChange={e => setPrepOpeningKey(e.target.value)}
            >
              <option value="">Current repertoire root</option>
              {prepOpeningOptions.map(opening => (
                <option key={opening.key} value={opening.key}>{opening.name}</option>
              ))}
            </select>
          </div>
          <FrontierQueuePanel
            frontiers={frontierQueue}
            rebuilding={rebuildingFrontiers}
            copyStatus={frontierCopyStatus}
            onRefresh={() => void refreshFrontierQueue()}
            onCopy={() => void copyFrontierQueue()}
          />
          {genTrace.length > 0 && (
            <GenerationTracePanel
              trace={genTrace}
              copyStatus={genTraceCopyStatus}
              onCopy={() => void copyGenerationTrace()}
            />
          )}
        </div>
      </div>
    );
  }

  if (phase.kind === 'prep-map' || phase.kind === 'prep-confirm') {
    const mapState = phase.kind === 'prep-confirm' ? phase.state : phase;
    const isYourTurn = turnAt(mapState.cursorFen) === repertoire.color;
    const sanLine = renderSanFromEdges(mapState.path);
    return (
      <div className="layout">
        <div>
          <Board
            fen={mapState.cursorFen}
            orientation={orientation}
            onMove={attemptPrepMove}
            allowMoves={phase.kind === 'prep-map' && isYourTurn && !mapState.loading}
            allowedDragColor={repertoire.color}
            size={boardSize}
            animatePositionChange={animateComputerMove}
            resizable
            onSizeChange={onBoardSizeChange}
          />
        </div>
        <div>
          <div className="panel prep-map-panel">
            <h3>Map my prep</h3>
            <div className="muted small">
              Chesski is walking the closest related popular opponent branches first. Play your prep on the board; press Not sure when you do not know or do not want a response.
            </div>
            <div className="prep-map-stats">
              <div><strong>{mapState.stats.movesMapped}</strong><span>moves mapped</span></div>
              <div><strong>{mapState.stats.frontiersCreated}</strong><span>frontiers</span></div>
              <div><strong>{mapState.stats.branchesExplored}</strong><span>branches checked</span></div>
              <div><strong>{mapState.stats.deepestPly}</strong><span>deepest ply</span></div>
            </div>
            {mapState.message && <div className="prep-map-message small">{mapState.message}</div>}
            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="primary"
                onClick={() => void stopPrepHere(mapState)}
                disabled={mapState.loading || phase.kind === 'prep-confirm'}
              >
                Not sure
              </button>
              <button onClick={() => setPhase({ kind: 'setup' })}>Stop mapping</button>
            </div>
          </div>
          <div className="panel">
            <h3>Current line</h3>
            <div className="mono small">
              {openingPreamble && <span className="muted">{openingPreamble} </span>}
              {sanLine || (openingPreamble ? '' : '(start)')}
            </div>
            <div className="muted small" style={{ marginTop: 8 }}>
              Queued related branches: {mapState.queue.length}
            </div>
          </div>
          <FrontierQueuePanel
            frontiers={frontierQueue}
            rebuilding={rebuildingFrontiers}
            copyStatus={frontierCopyStatus}
            onRefresh={() => void refreshFrontierQueue()}
            onCopy={() => void copyFrontierQueue()}
          />
        </div>
        {phase.kind === 'prep-confirm' && (
          <div className="modal-backdrop soft">
            <div className="modal">
              <h3>Keep this move?</h3>
              <div className="small">
                <strong className="mono">{phase.warning.san}</strong> has more losses than wins in the database:
                {' '}<strong>{phase.warning.wins.toLocaleString()}</strong> wins,
                {' '}<strong>{phase.warning.draws.toLocaleString()}</strong> draws,
                {' '}<strong>{phase.warning.losses.toLocaleString()}</strong> losses.
              </div>
              <div className="row" style={{ marginTop: 14 }}>
                <button className="primary" onClick={() => void commitPrepMove(phase.state, phase.move)}>Keep it</button>
                <button onClick={() => void stopPrepHere(phase.state)}>Not sure</button>
                <button onClick={() => setPhase(phase.state)}>Choose another move</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (phase.kind === 'generating' || phase.kind === 'line-ready') {
    const loadingCard = chooseLoadingHistoryCard(loadingHistoryProgress);
    return (
      <div className="layout">
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <div className="row">
            <h3>{phase.kind === 'generating' ? 'Preparing a new line...' : 'Line prepared'}</h3>
          </div>
          <div className="muted small">
            {phase.kind === 'generating'
              ? 'Chesski is generating your line. The trace below updates as each step finishes.'
              : 'Your line is ready when you are.'}
          </div>
          <GenerationTracePanel
            trace={genTrace}
            copyStatus={genTraceCopyStatus}
            onCopy={() => void copyGenerationTrace()}
          />
          {loadingCard && (
            <LoadingHistoryCard
              cardState={loadingCard}
              answerShown={loadingHistoryAnswerShown}
              onToggleAnswer={() => setLoadingHistoryAnswerShown(shown => !shown)}
              onGrade={(knewIt) => void gradeLoadingHistoryCard(loadingCard.id, knewIt)}
            />
          )}
          {phase.kind === 'line-ready' && (
            <div className="line-ready-action">
              <button className="primary study-line-button" onClick={() => studyPreparedLine(phase.line, phase.mode)}>
                Let's train!
              </button>
            </div>
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
            <div className="mono small">
              {openingPreamble && <span className="muted">{openingPreamble} </span>}
              {sanLineUpToHere || (openingPreamble ? '' : '(start)')}
            </div>
          </div>
          <LineEvalPanel line={phase.line.fullPath} currentFen={boardFen} color={repertoire.color} />
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
    const isYour = isTrainableEdge(cur, repertoire.color);
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
    const pillStates = computePillStates(phase, repertoire.color);
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
            <div className="mono small">
              {openingPreamble && <span className="muted">{openingPreamble} </span>}
              {sanLineUpToHere || (openingPreamble ? '' : '(start)')}
            </div>
          </div>
          <LineEvalPanel line={phase.line.fullPath} currentFen={boardFen} color={repertoire.color} />
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

function emptyPrepStats(): PrepMapStats {
  return { movesMapped: 0, frontiersCreated: 0, branchesExplored: 0, deepestPly: 0 };
}

function prepBranchKey(branch: Pick<PrepBranch, 'parentFen' | 'uci'>): string {
  return `${branch.parentFen}::${branch.uci}`;
}

function choosePrepBranch(queue: PrepBranch[]): PrepBranch | null {
  if (queue.length === 0) return null;
  return [...queue].sort((a, b) => (
    (b.depth - a.depth)
    || (b.weight - a.weight)
    || (b.games - a.games)
  ))[0];
}

function buildReviewQueue(edges: Edge[], includeFallback: boolean, cap: number): Edge[] {
  const now = new Date();
  const due = edges
    .filter(e => isDue(e, now))
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  if (due.length > 0 || !includeFallback) return due.slice(0, cap);
  return [...edges]
    .sort((a, b) => {
      const aReviewed = a.lastReviewedAt ? new Date(a.lastReviewedAt).getTime() : 0;
      const bReviewed = b.lastReviewedAt ? new Date(b.lastReviewedAt).getTime() : 0;
      if (aReviewed !== bReviewed) return aReviewed - bReviewed;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    })
    .slice(0, cap);
}

function SourceGamePanel({ edge, line, color }: { edge: Edge | null; line: Edge[]; color: Repertoire['color'] }) {
  const userEdges = line.filter(e => isTrainableEdge(e, color));
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

function LineEvalPanel({ line, currentFen, color }: { line: Edge[]; currentFen: string; color: Repertoire['color'] }) {
  const [currentEval, setCurrentEval] = useState<number | null | undefined>(undefined);
  const [finalEval, setFinalEval] = useState<number | null | undefined>(undefined);
  const finalFen = line[line.length - 1]?.childFen ?? currentFen;
  const mistakeEdge = line.find(edge => edge.mover !== color && edge.isMistake);

  useEffect(() => {
    let cancelled = false;
    setCurrentEval(undefined);
    setFinalEval(undefined);
    (async () => {
      const [current, final] = await Promise.all([
        evalForColor(currentFen, color),
        finalFen === currentFen ? Promise.resolve(null) : evalForColor(finalFen, color),
      ]);
      if (cancelled) return;
      setCurrentEval(current);
      setFinalEval(finalFen === currentFen ? current : final);
    })();
    return () => { cancelled = true; };
  }, [currentFen, finalFen, color]);

  return (
    <div className={'panel line-eval-panel' + (mistakeEdge ? ' punishing' : '')}>
      <h3>Engine eval</h3>
      <div className="line-eval-kind">
        {mistakeEdge ? 'Punishing opponent mistake' : 'Continuing the line'}
      </div>
      {mistakeEdge && (
        <div className="muted small">Opponent move: <span className="mono">{mistakeEdge.san}</span></div>
      )}
      <div className="line-eval-grid">
        <div>
          <span className="muted small">Current</span>
          <strong>{formatEval(currentEval)}</strong>
        </div>
        <div>
          <span className="muted small">Line end</span>
          <strong>{formatEval(finalEval)}</strong>
        </div>
      </div>
    </div>
  );
}

async function evalForColor(fen: string, color: Repertoire['color']): Promise<number | null> {
  try {
    const evaluation = await fetchCloudEval(fen, 1);
    if (!evaluation || evaluation.pvs.length === 0) return null;
    return pvCpForColor(evaluation.pvs[0], color);
  } catch {
    return null;
  }
}

function formatEval(cp: number | null | undefined): string {
  if (cp === undefined) return '...';
  if (cp === null) return 'No cloud eval';
  if (Math.abs(cp) > 90000) return cp > 0 ? 'Winning mate' : 'Mated';
  const pawns = cp / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`;
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
  const cards = buildHistoryCardStates(progressByCard, now)
    .filter(card => !progressByCard[card.id] || isHistoryDue(card.progress, now));
  const fallbackCards = cards.length > 0 ? cards : buildHistoryCardStates(progressByCard, now);
  if (fallbackCards.length === 0) return null;
  return fallbackCards
    .sort((a, b) => {
      const dueDelta = Number(isHistoryDue(b.progress, now)) - Number(isHistoryDue(a.progress, now));
      if (dueDelta !== 0) return dueDelta;
      const newDelta = Number(!progressByCard[b.id]) - Number(!progressByCard[a.id]);
      if (newDelta !== 0) return newDelta;
      const aReviewed = a.progress.lastReviewedAt ? new Date(a.progress.lastReviewedAt).getTime() : 0;
      const bReviewed = b.progress.lastReviewedAt ? new Date(b.progress.lastReviewedAt).getTime() : 0;
      if (aReviewed !== bReviewed) return aReviewed - bReviewed;
      return a.progress.dueAt.localeCompare(b.progress.dueAt);
    })[0];
}

function FrontierQueuePanel({ frontiers, rebuilding, copyStatus, onRefresh, onCopy }: {
  frontiers: FrontierCandidate[];
  rebuilding: boolean;
  copyStatus: string | null;
  onRefresh: () => void;
  onCopy: () => void;
}) {
  const open = frontiers.filter(frontier => frontier.status === 'open');
  const blocked = frontiers.filter(frontier => frontier.status === 'blocked');
  const answered = frontiers.filter(frontier => frontier.status === 'answered');
  const rows = frontiers.slice(0, 10);
  return (
    <div className="frontier-queue">
      <div className="frontier-queue-head">
        <div>
          <h3>Frontier queue</h3>
          <div className="muted small">
            {open.length} open, {blocked.length} blocked, {answered.length} answered. These are the candidate opponent continuations Chesski can train next.
          </div>
        </div>
        <div className="frontier-queue-actions">
          <button onClick={onRefresh} disabled={rebuilding}>{rebuilding ? 'Refreshing...' : 'Refresh list'}</button>
          <button onClick={onCopy} disabled={frontiers.length === 0}>Copy list</button>
        </div>
      </div>
      {copyStatus && <div className="muted small frontier-copy-status">{copyStatus}</div>}
      {rows.length === 0 ? (
        <div className="muted small frontier-empty">
          No stored frontiers yet. Press Refresh list or start Learn to build the queue.
        </div>
      ) : (
        <div className="frontier-table" role="table" aria-label="Frontier queue">
          <div className="frontier-row frontier-row-head" role="row">
            <span>Status</span>
            <span>Move</span>
            <span>Source</span>
            <span>Weight</span>
            <span>Games</span>
            <span>Child FEN</span>
          </div>
          {rows.map(frontier => (
            <div className="frontier-row" role="row" key={frontier.id} title={frontier.lastReason ?? frontier.childFen}>
              <span className={`frontier-status frontier-status-${frontier.status}`}>{frontier.status}</span>
              <span className="mono">{frontier.san} <span className="muted">({frontier.uci})</span></span>
              <span>{frontier.source}</span>
              <span>{frontier.weight.toFixed(5)}</span>
              <span>{frontier.games.toLocaleString()}</span>
              <span className="mono frontier-fen">{frontier.childFen}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GenerationTracePanel({ trace, copyStatus, onCopy }: {
  trace: string[];
  copyStatus: string | null;
  onCopy: () => void;
}) {
  if (trace.length === 0) return null;
  return (
    <div className="generation-trace">
      <div className="generation-trace-head">
        <div>
          <h3>Generation trace</h3>
          <div className="muted small">{trace.length} events. Copy this whole box back into chat when debugging.</div>
        </div>
        <button onClick={onCopy}>Copy trace</button>
      </div>
      {copyStatus && <div className="muted small generation-trace-copy">{copyStatus}</div>}
      <textarea
        className="generation-trace-text mono"
        readOnly
        value={trace.join('\n')}
        aria-label="Generation trace"
      />
    </div>
  );
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
      <div className="muted small">While Chesski builds the line</div>
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

function isTrainableEdge(edge: Edge, color: Repertoire['color']): boolean {
  return edge.mover === color && !edge.isScaffold;
}

function formatOpeningMoves(moves: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < moves.length; i++) {
    if (i % 2 === 0) parts.push(`${Math.floor(i / 2) + 1}.`);
    parts.push(moves[i]);
  }
  return parts.join(' ');
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
    return cur && !isTrainableEdge(cur, color) && next && isTrainableEdge(next, color) ? next : null;
  }
  if (phase.sub === 'good-flash') {
    const next = phase.line.fullPath[phase.cursorIdx + 1];
    const afterNext = phase.line.fullPath[phase.cursorIdx + 2];
    if (next && isTrainableEdge(next, color)) return next;
    if (next && !isTrainableEdge(next, color) && afterNext && isTrainableEdge(afterNext, color)) return afterNext;
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

function computePillStates(phase: Phase, color: Repertoire['color']): PillState[] {
  if (phase.kind !== 'walkthrough' && phase.kind !== 'test') return [];
  // Pills represent the user's NEW your-color moves (i.e., newEdges that are your color).
  const yourNewEdges = phase.line.newEdges.filter(e => isTrainableEdge(e, color));
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
