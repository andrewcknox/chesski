import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Board } from '../components/Board';
import { ClozePrompt } from '../components/ClozePrompt';
import { applyMove, computeOpeningFen, turnAt, STARTING_FEN_NORM } from '../lib/chess';
import { findOpening } from '../lib/openings';
import {
  assertLineRespectsScope,
  computeScopeKey,
  continueLearnLine,
  evaluateLineQuality,
  generateLearnLine,
  getPrepMoveWarning,
  getPrepOpponentBranches,
  rehydrateReadyLine,
  repairFrontierIndexAfterLearn,
  rebuildFrontierQueue,
  savePrepStopFrontier,
  evaluateMoveCpLoss,
  pvCpForWhite,
  TUNING,
  type GeneratedLine,
  type GenerationTrace,
  type PrepMoveWarning,
  type PrepOpponentBranch,
} from '../lib/autosuggest';
import { fetchCloudEval } from '../lib/lichess';
import { addMovesToRepertoire, CURATED_OPENINGS, countReadyLines, deleteReadyLine, getEdge, getEdgesByMover, getEdgesForRepertoire, getEdgesFromParent, getFrontiersForRepertoire, getReadyLines, getReadyLinesForRepertoire, markCuratedOpeningScaffolds, playMoveInRepertoire, putEdge, putReadyLine, swapMoveInRepertoire } from '../lib/storage';
import type { ReadyLine } from '../types';
import { readyLineId } from '../types';
import { listOpeningFoldersForRepertoire } from '../lib/openingFolders';
import { gradeFail, gradeLearnPass, gradePass, isDue } from '../lib/srs';
import { buildReviewQueue, edgesForOpeningFolder, isTrainableEdge } from '../lib/review';
import { buildReviewPlan, type ReviewPlan } from '../lib/reviewPlan';
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
  | {
      kind: 'review';
      queue: Edge[];           // legacy flat queue (still consumed when plan is absent)
      idx: number;             // legacy index into queue
      mode: SessionMode;
      sub: Sub;
      lastWrongUci: string | null;
      sameWrongCount: number;
      wrongCount: number;
      // NEW: line-aware delivery. When present, `idx`/`queue` are ignored by the
      // renderer; we walk segments[segmentIdx].path with prompts at the marked
      // pathIdx positions. See docs/wishlist.md "Chessable-style SRS review rework"
      // and the planner in lib/reviewPlan.ts.
      plan?: ReviewPlan;
      segmentIdx?: number;       // index into plan.segments
      contextPlyIdx?: number;    // index into plan.segments[segmentIdx].path
      promptIdxInSegment?: number; // index into segments[segmentIdx].prompts; === prompts.length when no more prompts in this segment
      gradedPromptEdgeIds?: string[]; // session-wide segmented review SRS grades, one grade per due card
      segmentRunUnclean?: boolean; // current segment pass had a miss, hint, skip, or other help
      segmentAttemptNumber?: number;
    }
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

function countTraceMatches(lines: string[], pattern: RegExp): number {
  return lines.reduce((count, line) => count + (pattern.test(line) ? 1 : 0), 0);
}

export interface TrainModeProps {
  repertoire: Repertoire;
  openingKey: string | null;
  onOpeningChange: (openingKey: string | null) => void;
  onDataChange: () => void;
  refreshKey: number;
  boardSize: number;
  onBoardSizeChange: (size: number) => void;
  onSessionActiveChange?: (active: boolean) => void;
  onBack?: () => void;
  prepMapRequest?: { repId: string; openingKey: string; nonce: number } | null;
  trainingStartRequest?: { repId: string; openingKey: string | null; nonce: number } | null;
  onPrepMapFinished?: () => void;
}

export function TrainMode({ repertoire, openingKey, onOpeningChange, onDataChange, refreshKey, boardSize, onBoardSizeChange, onSessionActiveChange, onBack, prepMapRequest, trainingStartRequest, onPrepMapFinished }: TrainModeProps) {
  const { preferences: trainingPreferences } = useTrainingPreferences();
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const [stats, setStats] = useState<SessionStats>(emptyStats());
  const [allEdges, setAllEdges] = useState<Edge[]>([]);
  const [genError, setGenError] = useState<string | null>(null);
  const [genTrace, setGenTrace] = useState<string[]>([]);
  const [genTraceCopyStatus, setGenTraceCopyStatus] = useState<string | null>(null);
  const [genFailureReason, setGenFailureReason] = useState<string | null>(null);
  const [failureReportCopyStatus, setFailureReportCopyStatus] = useState<string | null>(null);
  // Review-plan failure (Phase 6 wishlist item). Surfaces a copyable error
  // banner when the line-aware planner fails; the session still proceeds
  // via the legacy flat-queue path.
  const [reviewPlanError, setReviewPlanError] = useState<string | null>(null);
  const [reviewPlanErrorCopyStatus, setReviewPlanErrorCopyStatus] = useState<string | null>(null);
  const [frontierQueue, setFrontierQueue] = useState<FrontierCandidate[]>([]);
  const [frontierCopyStatus, setFrontierCopyStatus] = useState<string | null>(null);
  const [rebuildingFrontiers, setRebuildingFrontiers] = useState(false);
  const [showDebugInfo, setShowDebugInfo] = useState(false);
  const [prepOpeningKey, setPrepOpeningKey] = useState<string>(() => openingKey ?? repertoire.openingKey ?? '');
  const [queuedPremove, setQueuedPremove] = useState<{ from: string; to: string; promotion?: string } | null>(null);
  const [animateComputerMove, setAnimateComputerMove] = useState(false);
  const [loadingHistoryProgress, setLoadingHistoryProgress] = useState<ProgressByCard>({});
  const [loadingHistoryAnswerShown, setLoadingHistoryAnswerShown] = useState(false);
  const [lineViewIdx, setLineViewIdx] = useState<number | null>(null);

  // Persistent per-scope ready-line cache (IndexedDB-backed). The build worker fills
  // it up to TUNING.readyLineCap when the user is actively training a scope; Train
  // click consumes the oldest entry. Survives reloads — keep building lines stay ready
  // until they're actually studied.
  const [readyLines, setReadyLines] = useState<ReadyLine[]>([]);
  const [workerStatus, setWorkerStatus] = useState<'paused' | 'idle' | 'working' | 'error'>('paused');
  const workerRef = useRef<{ abort: AbortController | null }>({ abort: null });
  const fallbackReviewRef = useRef(false);
  const handledPrepMapRequestRef = useRef<number | null>(null);
  const handledTrainingStartRequestRef = useRef<number | null>(null);
  const repertoireRef = useRef(repertoire);
  repertoireRef.current = repertoire;
  const prepOpeningOptions = useMemo(
    () => CURATED_OPENINGS.filter(opening => opening.color === repertoire.color),
    [repertoire.color]
  );
  const selectedPrepOpening = useMemo(
    () => prepOpeningOptions.find(opening => opening.key === prepOpeningKey) ?? null,
    [prepOpeningKey, prepOpeningOptions]
  );
  // The scope key used by the line generator AND by the ready-line cache. Computed
  // synchronously from inputs so the worker, the panel, and the consumer all key on
  // the same string the generator uses internally.
  const currentScopeKey = useMemo(
    () => computeScopeKey(repertoire, selectedPrepOpening),
    [repertoire, selectedPrepOpening]
  );
  // Open frontiers within the current scope, used by the Frontier Index debug view
  // and failure reports. These are not generated ready lines.
  const scopedOpenFrontiers = useMemo(() => {
    if (!currentScopeKey) return [];
    return frontierQueue
      .filter(f => f.status === 'open' && f.scopeKey === currentScopeKey);
  }, [frontierQueue, currentScopeKey]);
  const scopedFrontierQueue = useMemo(() => {
    if (!currentScopeKey) return frontierQueue;
    return frontierQueue.filter(f => f.scopeKey === currentScopeKey);
  }, [frontierQueue, currentScopeKey]);
  const scopedFolder = useMemo(() => {
    if (!openingKey) return null;
    return listOpeningFoldersForRepertoire(repertoire, allEdges).find(folder => folder.key === openingKey) ?? null;
  }, [allEdges, openingKey, repertoire]);
  const scopedEdges = useMemo(
    () => scopedFolder ? edgesForOpeningFolder(scopedFolder, allEdges) : allEdges,
    [allEdges, scopedFolder]
  );

  // Stable refs so the long-running worker can read the latest values without
  // restarting on every dependency change.
  const selectedPrepOpeningRef = useRef(selectedPrepOpening);
  selectedPrepOpeningRef.current = selectedPrepOpening;
  const learnLineDepthRef = useRef(trainingPreferences.learnLineDepth);
  learnLineDepthRef.current = trainingPreferences.learnLineDepth;
  const reviewLinePlaybackDelayMsRef = useRef(trainingPreferences.reviewLinePlaybackDelayMs);
  reviewLinePlaybackDelayMsRef.current = trainingPreferences.reviewLinePlaybackDelayMs;

  const refreshReadyLines = useCallback(async () => {
    if (!currentScopeKey) {
      setReadyLines([]);
      return;
    }
    const lines = await getReadyLines(repertoire.id, currentScopeKey);
    const usable: ReadyLine[] = [];
    for (const line of lines) {
      const rehydrated = await rehydrateReadyLine(line);
      const respectsScope = rehydrated
        ? assertLineRespectsScope(rehydrated, repertoire, selectedPrepOpening ?? null)
        : false;
      if (rehydrated && respectsScope) {
        usable.push(line);
      } else {
        await deleteReadyLine(line.id);
      }
    }
    setReadyLines(usable);
  }, [currentScopeKey, repertoire, selectedPrepOpening]);

  const reload = useCallback(async () => {
    const [es, frontiers] = await Promise.all([
      getEdgesForRepertoire(repertoire.id),
      getFrontiersForRepertoire(repertoire.id),
    ]);
    setAllEdges(es);
    setFrontierQueue(frontiers);
    await refreshReadyLines();
  }, [repertoire.id, refreshReadyLines]);

  useEffect(() => { void reload(); }, [reload, refreshKey]);
  useEffect(() => {
    // Abort any in-flight build and reset session state when switching repertoires.
    workerRef.current.abort?.abort();
    workerRef.current = { abort: null };
    setWorkerStatus('paused');
    fallbackReviewRef.current = false;
    setPhase({ kind: 'setup' }); setStats(emptyStats()); setQueuedPremove(null); setLineViewIdx(null);
    setFrontierCopyStatus(null);
    setPrepOpeningKey(openingKey ?? repertoire.openingKey ?? '');
  }, [openingKey, repertoire.id, repertoire.openingKey]);
  useEffect(() => () => { workerRef.current.abort?.abort(); }, []);
  useEffect(() => {
    // Folder switch: stop building for the old scope (ready lines for the old folder
    // stay in the cache for next time). Worker will re-kick for the new scope below.
    workerRef.current.abort?.abort();
    workerRef.current = { abort: null };
    setWorkerStatus('paused');
    void refreshReadyLines();
  }, [currentScopeKey, refreshReadyLines]);
  // Rebuild the frontier index when the user lands on the setup screen for a new
  // scope. (Frontier index is the persistent set of opponent moves the generator
  // chooses from. It's not the ready-line cache; that's separate.)
  useEffect(() => {
    if (phase.kind !== 'setup') return;
    const controller = new AbortController();
    setGenTrace(prev => [...prev, `frontier refill start: reason=opening-selection, opening=${selectedPrepOpening?.name ?? 'root'}.`]);
    void (async () => {
      try {
        await rebuildFrontierQueue(repertoireRef.current, controller.signal, (message) => {
          setGenTrace(prev => [...prev, `frontier background: ${message}`]);
        }, selectedPrepOpening);
        if (!controller.signal.aborted) {
          await reload();
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setGenTrace(prev => [...prev, `frontier background: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`]);
        }
      }
    })();
    return () => controller.abort();
  }, [phase.kind, reload, selectedPrepOpening]);
  // Stable across walkthrough/test/review transitions so the worker doesn't restart
  // on every sub-phase change. Only flips on entry/exit to a training session.
  const isTraining = useMemo(
    () => phase.kind !== 'setup' && phase.kind !== 'done',
    [phase.kind]
  );
  // Build worker: runs only when user is actively training a scope. Refills the
  // ready-line cache up to TUNING.readyLineCap, then stops. Each line built goes
  // straight to IndexedDB so it survives reloads and accumulates over time.
  // Aborts cleanly on folder switch, repertoire switch, session end, or unmount.
  useEffect(() => {
    if (!isTraining || !currentScopeKey) {
      setWorkerStatus('paused');
      return;
    }
    const controller = new AbortController();
    workerRef.current.abort = controller;
    setWorkerStatus('idle');
    void (async () => {
      try {
        while (!controller.signal.aborted) {
          const count = await countReadyLines(repertoire.id, currentScopeKey);
          if (count >= TUNING.readyLineCap) break;
          setWorkerStatus('working');
          const rep = repertoireRef.current;
          const scope = selectedPrepOpeningRef.current;
          const depth = learnLineDepthRef.current;
          const trace: GenerationTrace = (message) =>
            setGenTrace(prev => [...prev, `worker(${currentScopeKey.slice(0, 40)}): ${message}`]);
          trace(`Build start (count=${count}/${TUNING.readyLineCap}).`);
          const line = await generateLearnLine(rep, depth, controller.signal, trace, scope);
          if (controller.signal.aborted) break;
          if (!line) {
            trace('Build produced no line; pausing worker.');
            break;
          }
          const startFen = line.fullPath[line.generationStartIndex - 1]?.childFen ?? rep.rootFen;
          const endFen   = line.fullPath[line.fullPath.length - 1]?.childFen ?? startFen;
          const quality = await evaluateLineQuality(startFen, endFen, rep.color, controller.signal, trace);
          assertLineRespectsScope(line, rep, scope ?? null, trace);
          const ready: ReadyLine = {
            id: readyLineId(rep.id, currentScopeKey),
            repertoireId: rep.id,
            scopeKey: currentScopeKey,
            fullPathEdgeIds: line.fullPath.map(e => e.id),
            newEdgeIds: line.newEdges.map(e => e.id),
            generationStartIndex: line.generationStartIndex,
            frontierId: line.frontierId,
            frontierFen: line.frontierFen,
            startFen,
            endFen,
            qualityDropCp: quality.dropCp,
            previewSan: renderSanFromEdges(line.fullPath),
            createdAt: new Date().toISOString(),
          };
          await putReadyLine(ready);
          await refreshReadyLines();
          setWorkerStatus('idle');
          trace(`Build complete: cached ready line ${ready.id}.`);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setWorkerStatus('error');
          setGenTrace(prev => [...prev, `worker error: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`]);
        }
      } finally {
        if (workerRef.current.abort === controller) {
          workerRef.current.abort = null;
        }
        if (!controller.signal.aborted) setWorkerStatus('paused');
      }
    })();
    return () => controller.abort();
  }, [isTraining, currentScopeKey, repertoire.id, refreshReadyLines]);
  useEffect(() => {
    (async () => setLoadingHistoryProgress(await getHistoryProgress()))();
  }, [refreshKey]);

  useEffect(() => {
    onSessionActiveChange?.(phase.kind !== 'setup' && phase.kind !== 'done');
  }, [phase.kind, onSessionActiveChange]);

  useEffect(() => {
    if (!prepMapRequest || prepMapRequest.repId !== repertoire.id) return;
    if (handledPrepMapRequestRef.current === prepMapRequest.nonce) return;
    if (prepOpeningKey !== prepMapRequest.openingKey) {
      setPrepOpeningKey(prepMapRequest.openingKey);
      onOpeningChange(prepMapRequest.openingKey);
      return;
    }
    if (phase.kind !== 'setup') return;
    handledPrepMapRequestRef.current = prepMapRequest.nonce;
    void startPrepMap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepMapRequest, prepOpeningKey, phase.kind, repertoire.id]);

  useEffect(() => {
    if (!trainingStartRequest || trainingStartRequest.repId !== repertoire.id) return;
    if (handledTrainingStartRequestRef.current === trainingStartRequest.nonce) return;
    if ((trainingStartRequest.openingKey ?? '') !== (openingKey ?? '')) {
      onOpeningChange(trainingStartRequest.openingKey);
      return;
    }
    if (phase.kind !== 'setup') return;
    handledTrainingStartRequestRef.current = trainingStartRequest.nonce;
    void startSession('learn-and-review');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trainingStartRequest, openingKey, phase.kind, repertoire.id]);

  useEffect(() => {
    if (phase.kind !== 'walkthrough' && phase.kind !== 'test') {
      setLineViewIdx(null);
      return;
    }
    setLineViewIdx(phase.sub === 'good-flash' ? phase.cursorIdx + 1 : phase.cursorIdx);
  }, [phase.kind, phase.kind === 'walkthrough' || phase.kind === 'test' ? phase.cursorIdx : null, phase.kind === 'walkthrough' || phase.kind === 'test' ? phase.sub : null]);

  const dueCount = useMemo(() => {
    const now = new Date();
    return scopedEdges.filter(e => isTrainableEdge(e, repertoire.color) && isDue(e, now)).length;
  }, [scopedEdges, repertoire.color]);

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
    } else if (phase.kind === 'review' && phase.plan) {
      // Line-aware (segmented) review delivery.
      if (phase.sub === 'good-flash') {
        timer = setTimeout(() => advanceReviewSegmentAfterFlash(), BAD_FLASH_MS);
      } else if (phase.sub === 'bad-flash') {
        timer = setTimeout(() => returnReviewToAwait(), BAD_FLASH_MS);
      } else if (phase.sub === 'await' && !isAtPromptNowInSegmentedReview(phase)) {
        // Auto-play the next context move (opponent move or non-due user move).
        timer = setTimeout(() => advanceSegmentedReviewContext(), reviewLinePlaybackDelayMsRef.current);
      }
    } else if (phase.kind === 'review') {
      // Legacy flat-queue delivery (plan absent or feature disabled).
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
    setGenFailureReason(null);
    setFailureReportCopyStatus(null);
    setReviewPlanError(null);
    setReviewPlanErrorCopyStatus(null);
    const traceStartedAt = performance.now();
    let traceIndex = 0;
    const localTrace: string[] = [];
    const trace: GenerationTrace = (message) => {
      const elapsed = ((performance.now() - traceStartedAt) / 1000).toFixed(2).padStart(6, ' ');
      traceIndex += 1;
      const line = `${String(traceIndex).padStart(3, '0')} +${elapsed}s ${message}`;
      localTrace.push(line);
      setGenTrace(prev => [...prev, line]);
    };
    trace(`Session requested: mode=${mode}, repertoire="${repertoire.name}", color=${repertoire.color}, root=${repertoire.rootFen}, opening=${selectedPrepOpening?.name ?? 'current root'}`);
    const allReadyAtStart = await getReadyLinesForRepertoire(repertoire.id);
    trace(`Queue key sanity: currentScopeKey=${currentScopeKey ?? '(null)'}, readyLineScopes=${summarizeReadyLineScopes(allReadyAtStart) || '(none)'}.`);
    fallbackReviewRef.current = mode === 'learn-and-review' && dueCount === 0;
    if (mode === 'review-only') {
      trace('Review-only mode selected; line generation skipped.');
      void enterReviewPhase(mode);
      return;
    }
    setLoadingHistoryAnswerShown(false);

    // Cache hit path: try to serve from the persistent ready-line cache for the current scope.
    if (currentScopeKey) {
      const cached = await getReadyLines(repertoire.id, currentScopeKey);
      trace(`Cache lookup: scope=${currentScopeKey}, found=${cached.length}.`);
      for (const ready of cached) {
        const rehydrated = await rehydrateReadyLine(ready);
        // Consume the cache slot regardless of rehydration outcome — if it's stale,
        // we don't want to keep trying it. The worker will refill an empty slot.
        await deleteReadyLine(ready.id);
        await refreshReadyLines();
        if (rehydrated) {
          if (!assertLineRespectsScope(rehydrated, repertoire, selectedPrepOpening ?? null, trace)) {
            trace(`Cache invalidated: ready line ${ready.id} does not match current scope=${currentScopeKey}.`);
            continue;
          }
          trace(`Cache hit: served ready line ${ready.id} (built ${ready.createdAt}, drop=${ready.qualityDropCp != null ? (ready.qualityDropCp/100).toFixed(2) : 'n/a'}).`);
          await reload();
          onDataChange();
          setPhase({ kind: 'line-ready', line: rehydrated, mode });
          return;
        }
        trace(`Cache stale: ready line ${ready.id} could not rehydrate (missing edge); trying next.`);
      }
      trace('Cache miss or all entries stale; falling through to live generation.');
    } else {
      trace('Cache lookup skipped: no scope selected.');
    }

    setPhase({ kind: 'generating', mode });
    let line: GeneratedLine | null;
    try {
      line = await generateLearnLine(repertoire, trainingPreferences.learnLineDepth, undefined, trace, selectedPrepOpening);
    } catch (e) {
      trace(`Generation threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      setGenError(e instanceof Error ? e.message : String(e));
      setGenFailureReason(`generateLearnLine threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      setPhase({ kind: 'setup' });
      return;
    }
    if (!line) {
      trace('Generation returned null.');
      const detail = await buildGenerationFailureDetail(repertoire.id, currentScopeKey, localTrace);
      setGenError(detail.message);
      setGenFailureReason(detail.reason);
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

  function summarizeReadyLineScopes(lines: ReadyLine[]): string {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line.scopeKey, (counts.get(line.scopeKey) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([scopeKey, count]) => `${scopeKey}=${count}`)
      .join(', ');
  }

  async function buildGenerationFailureDetail(
    repertoireId: string,
    scopeKey: string | null,
    traceLines: string[]
  ): Promise<{ message: string; reason: string }> {
    const [frontiers, allReady] = await Promise.all([
      getFrontiersForRepertoire(repertoireId),
      getReadyLinesForRepertoire(repertoireId),
    ]);
    const scopedFrontiers = scopeKey ? frontiers.filter(frontier => frontier.scopeKey === scopeKey) : frontiers;
    const open = scopedFrontiers.filter(frontier => frontier.status === 'open').length;
    const blocked = scopedFrontiers.filter(frontier => frontier.status === 'blocked').length;
    const answered = scopedFrontiers.filter(frontier => frontier.status === 'answered').length;
    const readyInScope = scopeKey ? allReady.filter(line => line.scopeKey === scopeKey).length : allReady.length;
    const attempted = countTraceMatches(traceLines, /Quality gate: attempt \d+ started/);
    const failedQuality = countTraceMatches(traceLines, /Quality gate: attempt \d+ rejected/);
    const noUser = countTraceMatches(traceLines, /could not add a user move|no legal user move|zero user moves/i);
    const timeout = traceLines.some(line => /timeout before attempt|Attempt aborted/.test(line));
    const noFrontier = traceLines.some(line => /no open candidates remained|final search produced no open candidates|no indexed or bounded frontier found/i.test(line));
    const queueScopes = summarizeReadyLineScopes(allReady) || '(none)';

    let message: string;
    if (failedQuality > 0) {
      message = `Could not generate a line: ${failedQuality} candidate line${failedQuality === 1 ? '' : 's'} failed the quality gate.`;
    } else if (noUser > 0) {
      message = 'Could not generate a line: candidate frontiers were found, but Chesski could not add a usable user continuation.';
    } else if (timeout) {
      message = 'Could not generate a line: generation timed out or was aborted before a usable line passed.';
    } else if (noFrontier || open === 0) {
      message = 'Could not generate a line: no open frontier candidates remained after rebuild/search.';
    } else {
      message = 'Could not generate a line: no generated candidate passed the current filters.';
    }

    const reason = [
      message,
      `scope=${scopeKey ?? '(null)'}`,
      `totalKnownFrontiers=${scopedFrontiers.length}`,
      `openFrontiers=${open}`,
      `blockedFrontiers=${blocked}`,
      `answeredFrontiers=${answered}`,
      `readyQueueInScope=${readyInScope}`,
      `readyLineScopes=${queueScopes}`,
      `attemptedCandidates=${attempted}`,
      `failedQualityGate=${failedQuality}`,
      `failedNoUserMove=${noUser}`,
    ].join(' | ');
    return { message, reason };
  }

  function buildFailureReport(): string {
    const openFrontiers = frontierQueue.filter(f => f.status === 'open');
    const blockedFrontiers = frontierQueue.filter(f => f.status === 'blocked');
    const answeredFrontiers = frontierQueue.filter(f => f.status === 'answered');
    const scopedOpen = scopedOpenFrontiers.length;
    const opening = selectedPrepOpening ? `${selectedPrepOpening.key} (${selectedPrepOpening.name})` : 'entire repertoire';
    const computedOpeningFen = selectedPrepOpening
      ? (() => { try { return computeOpeningFen(selectedPrepOpening.moves); } catch { return '(uncomputable)'; } })()
      : '(rootFen)';
    const header = [
      `=== Chesski Train: Line generation FAILURE report ===`,
      `Final reason: ${genFailureReason ?? '(unspecified)'}`,
      ``,
      `--- Scope ---`,
      `Repertoire id: ${repertoire.id}`,
      `Repertoire name: ${repertoire.name}`,
      `Repertoire color: ${repertoire.color}`,
      `Repertoire rootFen: ${repertoire.rootFen}`,
      `Opening folder: ${opening}`,
      `Opening folder FEN (computed): ${computedOpeningFen}`,
      `currentScopeKey: ${currentScopeKey ?? '(null — no scope selected)'}`,
      ``,
      `--- Counts ---`,
      `Candidate edges in scope: ${scopedEdges.length}`,
      `Frontier index total: ${frontierQueue.length}`,
      `  open: ${openFrontiers.length} (${scopedOpen} in current scope)`,
      `  blocked: ${blockedFrontiers.length}`,
      `  answered: ${answeredFrontiers.length}`,
      `Generated line queue (current scope): ${readyLines.length}`,
      ``,
      `--- Worker ---`,
      `Status: ${workerStatus}`,
      `AbortController attached: ${workerRef.current.abort ? 'yes' : 'no'}`,
      ``,
      `--- Top scoped open frontiers (up to 10) ---`,
    ].join('\n');
    const frontierLines = scopedOpenFrontiers.slice(0, 10).map((f, i) =>
      `${i + 1}. ${f.san} (${f.uci}) | games=${f.games} | weight=${f.weight.toFixed(5)} (display only) | source=${f.source} | childFen=${f.childFen}`
    ).join('\n');
    const traceBlock = [
      ``,
      `--- Generation trace (${genTrace.length} events) ---`,
      genTrace.length === 0 ? '(empty)' : genTrace.join('\n'),
    ].join('\n');
    return [header, frontierLines || '(none)', traceBlock].join('\n');
  }

  async function copyFailureReport() {
    const text = buildFailureReport();
    try {
      await navigator.clipboard.writeText(text);
      setFailureReportCopyStatus('Copied failure report');
    } catch {
      setFailureReportCopyStatus('Copy failed; select the text in the panel below');
    }
  }

  async function refreshFrontierQueue() {
    setRebuildingFrontiers(true);
    setFrontierCopyStatus(null);
    try {
      await rebuildFrontierQueue(repertoire, undefined, (message) => {
        setGenTrace(prev => [...prev, `frontier refresh: ${message}`]);
      }, selectedPrepOpening);
      await reload();
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setRebuildingFrontiers(false);
    }
  }

  async function copyFrontierQueue() {
    const storedMoveKeys = new Set(allEdges.map(edge => `${edge.parentFen}::${edge.uci}`));
    const generatedFrontierIds = new Set(readyLines.map(line => line.frontierId).filter(Boolean));
    const generatedFrontierFens = new Set(readyLines.map(line => line.frontierFen).filter(Boolean));
    const text = frontierQueue.map((frontier, idx) => [
      `${idx + 1}. ${frontierDisplayStatus(frontier, readyLines).toUpperCase()} ${frontier.san} (${frontier.uci})`,
      `source=${frontier.source}`,
      `weight=${frontier.weight.toFixed(5)}`,
      `games=${frontier.games}`,
      `popularity=${frontier.popularityFraction.toFixed(3)}`,
      `storedMove=${storedMoveKeys.has(`${frontier.parentFen}::${frontier.uci}`) ? 'yes' : 'no'}`,
      `generatedLine=${generatedFrontierIds.has(frontier.id) || generatedFrontierFens.has(frontier.childFen) ? 'yes' : 'no'}`,
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
    workerRef.current.abort?.abort();
    workerRef.current = { abort: null };
    setWorkerStatus('paused');
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
      setGenError(`"${repertoire.name}" starts from a different opening position. To map ${opening.name} inside a multi-opening repertoire, choose a standard repertoire that starts from the normal initial position.`);
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
    // The build worker auto-starts on this phase change via its useEffect dep on phase.kind.
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
    let reviewEdges: Edge[];
    let allRepEdges: Edge[] | null = null;
    let scopeRootFen: NormFen;
    if (scopedFolder) {
      // Use all repo edges for BFS navigation so the traversal can step through opponent
      // moves (e.g. Black responses in the Italian) to reach the White reply positions.
      // The result is then filtered to `fresh` (non-scaffold, user-color only).
      allRepEdges = await getEdgesForRepertoire(repertoire.id);
      reviewEdges = edgesForOpeningFolder(scopedFolder, fresh, allRepEdges);
      scopeRootFen = scopedFolder.baseFen;
    } else {
      reviewEdges = fresh;
      scopeRootFen = repertoire.rootFen;
    }
    const queue = buildReviewQueue(reviewEdges, mode === 'learn-and-review', trainingPreferences.reviewSessionLength, fallbackReviewRef.current);
    fallbackReviewRef.current = false;
    if (queue.length === 0) {
      setPhase({ kind: 'done', mode });
      return;
    }

    // Try the line-aware planner. The planner consumes the same scoped edge
    // set the flat queue was built from; both walks share scopeRootFen so
    // they can't diverge. The planner is read-only over edges.
    let plan: ReviewPlan | null = null;
    let planError: Error | null = null;
    if (trainingPreferences.useLineAwareReview) {
      try {
        // For path traversal we need the full repertoire edge graph (so the BFS
        // can step through opponent scaffold moves to reach user-mover positions).
        const navigationEdges = allRepEdges ?? await getEdgesForRepertoire(repertoire.id);
        // When folder-scoped, restrict the planner's edge graph to in-scope
        // edges (using the same edgesForOpeningFolder filter with full navigation).
        // Use ALL edges (not just `fresh`) so opponent moves are reachable on the path.
        const planningEdges = scopedFolder
          ? edgesForOpeningFolder(scopedFolder, navigationEdges, navigationEdges)
          : navigationEdges;
        plan = buildReviewPlan(queue, planningEdges, scopeRootFen);
      } catch (e) {
        planError = e instanceof Error ? e : new Error(String(e));
      }
    }

    if (plan && plan.segments.length > 0) {
      setReviewPlanError(null);
      setPhase({
        kind: 'review',
        queue, idx: 0, mode, sub: 'await',
        lastWrongUci: null, sameWrongCount: 0, wrongCount: 0,
        plan,
        segmentIdx: 0,
        contextPlyIdx: 0,
        promptIdxInSegment: indexOfFirstPromptAtOrAfter(plan.segments[0], 0),
        gradedPromptEdgeIds: [],
        segmentRunUnclean: false,
        segmentAttemptNumber: 1,
      });
      return;
    }

    // Plan failed or returned empty. If line-aware review was requested,
    // surface the failure (copyable banner) but still proceed via the flat
    // queue so the user can complete their session.
    if (trainingPreferences.useLineAwareReview) {
      const reportBody = buildReviewPlanFailureReport({
        repertoire, scopeRootFen, scopedFolder,
        flatQueueCount: queue.length, scopedEdgeCount: reviewEdges.length,
        plan, error: planError,
      });
      setReviewPlanError(reportBody);
    }
    setPhase({ kind: 'review', queue, idx: 0, mode, sub: 'await', lastWrongUci: null, sameWrongCount: 0, wrongCount: 0 });
  }

  function buildReviewPlanFailureReport(opts: {
    repertoire: Repertoire;
    scopeRootFen: NormFen;
    scopedFolder: ReturnType<typeof listOpeningFoldersForRepertoire>[number] | null;
    flatQueueCount: number;
    scopedEdgeCount: number;
    plan: ReviewPlan | null;
    error: Error | null;
  }): string {
    const head = [
      '=== Chesski Train: review-plan FAILURE report ===',
      `Final reason: ${opts.error ? `planner threw: ${opts.error.name}: ${opts.error.message}` : 'planner returned zero segments while flat queue had cards'}`,
      '',
      '--- Scope ---',
      `Repertoire id: ${opts.repertoire.id}`,
      `Repertoire name: ${opts.repertoire.name}`,
      `Repertoire color: ${opts.repertoire.color}`,
      `Repertoire rootFen: ${opts.repertoire.rootFen}`,
      `Opening folder: ${opts.scopedFolder ? `${opts.scopedFolder.key} (${opts.scopedFolder.name})` : 'entire repertoire'}`,
      `scopeRootFen: ${opts.scopeRootFen}`,
      '',
      '--- Counts ---',
      `Due cards (flat queue): ${opts.flatQueueCount}`,
      `Scoped edges fed to planner: ${opts.scopedEdgeCount}`,
      `Segments produced: ${opts.plan?.segments.length ?? 0}`,
      `Total prompts: ${opts.plan?.totalPrompts ?? 0}`,
      `Dropped cards: ${opts.plan?.droppedCards.length ?? 0}`,
      '',
      '--- Planner trace ---',
      opts.plan ? opts.plan.trace.join('\n') : '(no plan returned — planner threw before producing output)',
    ];
    if (opts.error?.stack) {
      head.push('', '--- Thrown error stack ---', opts.error.stack);
    }
    return head.join('\n');
  }

  async function copyReviewPlanFailureReport() {
    if (!reviewPlanError) return;
    try {
      await navigator.clipboard.writeText(reviewPlanError);
      setReviewPlanErrorCopyStatus('Copied review-plan failure report');
    } catch {
      setReviewPlanErrorCopyStatus('Copy failed; expand the report below and copy from the textarea');
    }
  }

  // Find the first prompt in a segment at or after a given pathIdx. Returns the
  // prompt's index in segment.prompts (so we can compare prompts[idx].pathIdx
  // against contextPlyIdx to decide "at prompt now"). Returns prompts.length
  // when no more prompts remain in the segment.
  function indexOfFirstPromptAtOrAfter(segment: ReviewPlan['segments'][number], pathIdx: number): number {
    for (let i = 0; i < segment.prompts.length; i++) {
      if (segment.prompts[i].pathIdx >= pathIdx) return i;
    }
    return segment.prompts.length;
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

  function revealCurrentHint() {
    const cur = phaseRef.current;
    if (cur.kind === 'review' && cur.plan && cur.sub === 'await' && isAtPromptNowInSegmentedReview(cur)) {
      const promptEdge = currentSegmentedPromptEdge(cur);
      if (!promptEdge) return;
      const gradedIds = cur.gradedPromptEdgeIds ?? [];
      const alreadyGraded = gradedIds.includes(promptEdge.id);
      setPhase({
        ...cur,
        wrongCount: Math.max(cur.wrongCount, HINT_AFTER_WRONG_COUNT),
        segmentRunUnclean: true,
        gradedPromptEdgeIds: alreadyGraded ? gradedIds : [...gradedIds, promptEdge.id],
      });
      if (!alreadyGraded) {
        void persistSegmentedReviewGrade(promptEdge, 'fail');
      }
      return;
    }

    setPhase(p => {
      if (p.kind === 'walkthrough' || p.kind === 'test') {
        const edge = p.line.fullPath[p.cursorIdx];
        if (!edge || !isTrainableEdge(edge, repertoire.color) || p.sub !== 'await') return p;
        return { ...p, wrongCount: Math.max(p.wrongCount, HINT_AFTER_WRONG_COUNT) };
      }
      if (p.kind === 'review' && p.sub === 'await') {
        return { ...p, wrongCount: Math.max(p.wrongCount, HINT_AFTER_WRONG_COUNT) };
      }
      return p;
    });
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
    // After a Learn line completes, the review phase runs through the same
    // pipeline as the standalone Review-only entry. enterReviewPhase already
    // pulls fresh edges, applies folder scoping, builds the flat queue, and
    // (when enabled) the line-aware plan.
    await enterReviewPhase(mode);
  }

  async function completeTestLine(p: Extract<Phase, { kind: 'test' }>) {
    const learnedEdges = p.line.newEdges.filter(e => isTrainableEdge(e, repertoire.color));
    for (const edge of learnedEdges) {
      const latest = await getEdge(repertoire.id, edge.parentFen, edge.childFen);
      await putEdge(gradeLearnPass(latest ?? edge));
    }
    // Abort any in-flight build before we mutate the frontier index — the worker
    // would otherwise be operating against stale state. The worker effect kicks
    // back in once frontiers are repaired and reload() completes.
    workerRef.current.abort?.abort();
    workerRef.current = { abort: null };
    setWorkerStatus('paused');
    setGenTrace(prev => [...prev, 'pre-generation paused: learned line completed; repairing frontier index from the updated line.']);
    await reload();
    onDataChange();
    setRebuildingFrontiers(true);
    try {
      await repairFrontierIndexAfterLearn(repertoire, p.line, selectedPrepOpening, undefined, (message) => {
        setGenTrace(prev => [...prev, `frontier repair after learn: ${message}`]);
      });
      await reload();
      setGenTrace(prev => [...prev, 'frontier repair after learn: local update complete.']);
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

  // ---------- Segmented (line-aware) review ----------
  // These helpers handle the Chessable-style delivery when `phase.plan` is
  // present. They mirror the flat-queue helpers above but walk a segment's
  // path with prompt points instead of a flat card list.

  function isAtPromptNowInSegmentedReview(p: Extract<Phase, { kind: 'review' }>): boolean {
    if (!p.plan || p.segmentIdx === undefined || p.contextPlyIdx === undefined || p.promptIdxInSegment === undefined) return false;
    const seg = p.plan.segments[p.segmentIdx];
    if (!seg) return false;
    const prompt = seg.prompts[p.promptIdxInSegment];
    if (!prompt) return false;
    return prompt.pathIdx === p.contextPlyIdx;
  }

  function currentSegmentedPromptEdge(p: Extract<Phase, { kind: 'review' }>): Edge | null {
    if (!p.plan || p.segmentIdx === undefined || p.contextPlyIdx === undefined) return null;
    if (!isAtPromptNowInSegmentedReview(p)) return null;
    return p.plan.segments[p.segmentIdx]?.path[p.contextPlyIdx] ?? null;
  }

  async function persistSegmentedReviewGrade(edge: Edge, grade: 'pass' | 'fail') {
    const latest = await getEdge(repertoire.id, edge.parentFen, edge.childFen);
    const updated = grade === 'pass'
      ? gradePass(latest ?? edge)
      : gradeFail(latest ?? edge);
    void putEdge(updated);
    setStats(s => grade === 'pass'
      ? ({ ...s, reviewPassed: s.reviewPassed + 1 })
      : ({ ...s, reviewFailed: s.reviewFailed + 1 }));
  }

  function advanceSegmentedReviewContext() {
    setPhase(p => {
      if (p.kind !== 'review' || !p.plan || p.segmentIdx === undefined || p.contextPlyIdx === undefined) return p;
      const seg = p.plan.segments[p.segmentIdx];
      if (!seg) return p;
      const nextPly = p.contextPlyIdx + 1;
      if (nextPly >= seg.path.length) {
        // Segment exhausted; repeat it until the current pass was clean.
        return completeOrRepeatReviewSegment(p);
      }
      return {
        ...p,
        contextPlyIdx: nextPly,
        promptIdxInSegment: indexOfFirstPromptAtOrAfterPly(seg, nextPly),
        sub: 'await',
        lastWrongUci: null,
        sameWrongCount: 0,
        wrongCount: 0,
      };
    });
  }

  function jumpToNextSegment(p: Extract<Phase, { kind: 'review' }>): Phase {
    if (!p.plan) return p;
    const nextSegIdx = (p.segmentIdx ?? 0) + 1;
    if (nextSegIdx >= p.plan.segments.length) return { kind: 'done', mode: p.mode };
    const nextSeg = p.plan.segments[nextSegIdx];
    return {
      ...p,
      segmentIdx: nextSegIdx,
      contextPlyIdx: 0,
      promptIdxInSegment: indexOfFirstPromptAtOrAfterPly(nextSeg, 0),
      sub: 'await',
      lastWrongUci: null,
      sameWrongCount: 0,
      wrongCount: 0,
      segmentRunUnclean: false,
      segmentAttemptNumber: 1,
    };
  }

  // (restartReviewSegment removed 2026-05: the segmented review no longer loops
  // back to redo a segment on imperfect passes. completeOrRepeatReviewSegment
  // always advances. The `segmentRunUnclean` field is still written by the
  // wrong/hint/skip handlers but is no longer read for control flow; left in
  // place so a future feature can resurface "you had X misses on this pass" UI
  // without re-plumbing.)

  function completeOrRepeatReviewSegment(p: Extract<Phase, { kind: 'review' }>): Phase {
    if (!p.plan) return p;
    // After a single pass-through, advance to the next segment regardless of
    // whether the pass had mistakes. Missed prompts already had gradeFail fire
    // (dueAt = endOfTodayISO), so they'll resurface tomorrow via SRS. An older
    // version of this function looped back to `restartReviewSegment(p)` when
    // `p.segmentRunUnclean` was true, which trapped users in a "same line over
    // and over" loop on any imperfect pass. The repeat-until-clean behavior was
    // undocumented and surprising; removed 2026-05.
    return jumpToNextSegment(p);
  }

  function indexOfFirstPromptAtOrAfterPly(seg: ReviewPlan['segments'][number], pathIdx: number): number {
    for (let i = 0; i < seg.prompts.length; i++) {
      if (seg.prompts[i].pathIdx >= pathIdx) return i;
    }
    return seg.prompts.length;
  }

  function advanceReviewSegmentAfterFlash() {
    setPhase(p => {
      if (p.kind !== 'review' || !p.plan || p.segmentIdx === undefined || p.contextPlyIdx === undefined) return p;
      const seg = p.plan.segments[p.segmentIdx];
      if (!seg) return p;
      const nextPly = p.contextPlyIdx + 1;
      if (nextPly >= seg.path.length) return completeOrRepeatReviewSegment(p);
      return {
        ...p,
        contextPlyIdx: nextPly,
        promptIdxInSegment: indexOfFirstPromptAtOrAfterPly(seg, nextPly),
        sub: 'await',
        lastWrongUci: null,
        sameWrongCount: 0,
        wrongCount: 0,
      };
    });
  }

  async function attemptSegmentedReviewMove(move: { from: string; to: string; promotion?: string }): Promise<boolean> {
    const p = phaseRef.current;
    if (p.kind !== 'review' || !p.plan || p.segmentIdx === undefined || p.contextPlyIdx === undefined) return false;
    if (p.sub !== 'await') return false;
    if (!isAtPromptNowInSegmentedReview(p)) return false;
    const promptEdge = currentSegmentedPromptEdge(p);
    if (!promptEdge) return false;
    const result = applyMove(promptEdge.parentFen, move);
    if (!result) return false;
    if (result.uci === promptEdge.uci) {
      const gradedIds = p.gradedPromptEdgeIds ?? [];
      const alreadyGraded = gradedIds.includes(promptEdge.id);
      const shouldGradePass = p.wrongCount === 0 && !alreadyGraded;
      setPhase({
        ...p,
        sub: 'good-flash',
        lastWrongUci: null,
        sameWrongCount: 0,
        gradedPromptEdgeIds: shouldGradePass ? [...gradedIds, promptEdge.id] : gradedIds,
      });
      if (shouldGradePass) {
        // Fetch the latest edge state from DB before grading — the plan was
        // built at session start and SRS state may have advanced via interim
        // training. Same defensive pattern as completeTestLine().
        void persistSegmentedReviewGrade(promptEdge, 'pass');
      }
      return true;
    }
    const sameAsLast = p.lastWrongUci === result.uci;
    const newSameCount = sameAsLast ? p.sameWrongCount + 1 : 1;
    const newWrongCount = p.wrongCount + 1;
    const gradedIds = p.gradedPromptEdgeIds ?? [];
    const alreadyGraded = gradedIds.includes(promptEdge.id);
    const shouldGradeFail = !alreadyGraded;
    if (shouldGradeFail) {
      void persistSegmentedReviewGrade(promptEdge, 'fail');
    }
    setPhase({
      ...p,
      sub: 'bad-flash',
      lastWrongUci: result.uci,
      sameWrongCount: newSameCount,
      wrongCount: newWrongCount,
      segmentRunUnclean: true,
      gradedPromptEdgeIds: shouldGradeFail ? [...gradedIds, promptEdge.id] : gradedIds,
    });
    if (newSameCount >= OVERRIDE_AFTER_SAME_WRONG_COUNT) {
      setTimeout(() => triggerReviewOverride(promptEdge, result.uci), BAD_FLASH_MS + 50);
    }
    return true;
  }

  function handleSkipSegmentedReview() {
    const p = phaseRef.current;
    if (p.kind !== 'review' || !p.plan) return;
    if (!isAtPromptNowInSegmentedReview(p)) return;
    const promptEdge = currentSegmentedPromptEdge(p);
    const gradedIds = p.gradedPromptEdgeIds ?? [];
    const alreadyGraded = !!promptEdge && gradedIds.includes(promptEdge.id);
    if (promptEdge && !alreadyGraded) {
      void persistSegmentedReviewGrade(promptEdge, 'fail');
    }
    setStats(s => ({ ...s, reviewSkipped: s.reviewSkipped + 1 }));
    setPhase({
      ...p,
      sub: 'good-flash',
      lastWrongUci: null,
      sameWrongCount: 0,
      wrongCount: 0,
      segmentRunUnclean: true,
      gradedPromptEdgeIds: promptEdge && !alreadyGraded ? [...gradedIds, promptEdge.id] : gradedIds,
    });
  }

  // ---------- Render ----------

  const orientation: 'white' | 'black' = repertoire.color === 'w' ? 'white' : 'black';
  const openingPreamble = useMemo(() => {
    if (repertoire.rootFen === STARTING_FEN_NORM || !repertoire.openingKey) return null;
    const opening = findOpening(repertoire.openingKey);
    if (!opening) return null;
    return formatOpeningMoves(opening.moves);
  }, [repertoire.rootFen, repertoire.openingKey]);
  const scopeTitle = scopedFolder ? `${repertoire.name} / ${scopedFolder.name}` : repertoire.name;
  const scopeLabel = `Training: ${scopeTitle}`;

  if (phase.kind === 'setup') {
    return (
      <>
      {onBack && (
        <div className="subview-back-row">
          <button onClick={onBack}>Back</button>
        </div>
      )}
      <div className="layout">
        <div className="panel training-setup-panel" style={{ gridColumn: '1 / -1' }}>
          <div className="page-header compact">
            <div>
              <div className="eyebrow">{scopeLabel}</div>
              <h1>Train this opening</h1>
              <p>{repertoire.color === 'w' ? 'White' : 'Black'} to move when the line belongs to you.</p>
            </div>
          </div>
          {genError && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ color: 'var(--bad)', flex: 1 }} className="small">{genError}</div>
                <button
                  className="small"
                  onClick={() => void copyFailureReport()}
                  title="Copy a self-contained failure report (scope, counts, worker state, trace) to the clipboard"
                >
                  Copy failure report
                </button>
              </div>
              {failureReportCopyStatus && (
                <div className="muted small" style={{ marginTop: 4 }}>{failureReportCopyStatus}</div>
              )}
              {genTrace.length > 0 && (
                <details style={{ marginTop: 6 }}>
                  <summary className="muted small" style={{ cursor: 'pointer' }}>
                    Show failure trace ({genTrace.length} events)
                  </summary>
                  <textarea
                    readOnly
                    value={buildFailureReport()}
                    className="mono"
                    aria-label="Failure report"
                    style={{ width: '100%', minHeight: 200, marginTop: 4, fontSize: 11 }}
                  />
                </details>
              )}
            </div>
          )}
          {reviewPlanError && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ color: 'var(--bad)', flex: 1 }} className="small">
                  Line-aware review planner failed for the last session — falling back to flat one-card-at-a-time review. The session still ran; copy the report if you want help diagnosing.
                </div>
                <button
                  className="small"
                  onClick={() => void copyReviewPlanFailureReport()}
                  title="Copy a self-contained review-plan failure report (scope, counts, trace, error) to the clipboard"
                >
                  Copy review-plan report
                </button>
              </div>
              {reviewPlanErrorCopyStatus && (
                <div className="muted small" style={{ marginTop: 4 }}>{reviewPlanErrorCopyStatus}</div>
              )}
              <details style={{ marginTop: 6 }}>
                <summary className="muted small" style={{ cursor: 'pointer' }}>Show review-plan report</summary>
                <textarea
                  readOnly
                  value={reviewPlanError}
                  className="mono"
                  aria-label="Review-plan failure report"
                  style={{ width: '100%', minHeight: 200, marginTop: 4, fontSize: 11 }}
                />
              </details>
            </div>
          )}
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
            <label className="small muted" htmlFor="prep-opening-select">Opening folder</label>
            <select
              id="prep-opening-select"
              value={prepOpeningKey}
              onChange={e => {
                setPrepOpeningKey(e.target.value);
                onOpeningChange(e.target.value || null);
              }}
            >
              <option value="">Entire repertoire</option>
              {prepOpeningOptions.map(opening => (
                <option key={opening.key} value={opening.key}>{opening.name}</option>
              ))}
            </select>
          </div>
          <LineQueuePanel
            openingLabel={selectedPrepOpening?.name ?? 'Entire repertoire'}
            readyLines={readyLines}
            workerStatus={workerStatus}
          />
          <label className="muted small" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
            <input type="checkbox" checked={showDebugInfo} onChange={e => setShowDebugInfo(e.target.checked)} />
            Show debug info (frontier index + raw trace)
          </label>
          {showDebugInfo && (
            <FrontierQueuePanel
              frontiers={scopedFrontierQueue}
              readyLines={readyLines}
              edges={scopedEdges}
              rebuilding={rebuildingFrontiers}
              copyStatus={frontierCopyStatus}
              onRefresh={() => void refreshFrontierQueue()}
              onCopy={() => void copyFrontierQueue()}
            />
          )}
          {showDebugInfo && genTrace.length > 0 && (
            <GenerationTracePanel
              trace={genTrace}
              copyStatus={genTraceCopyStatus}
              onCopy={() => void copyGenerationTrace()}
            />
          )}
        </div>
      </div>
      </>
    );
  }

  if (phase.kind === 'prep-map' || phase.kind === 'prep-confirm') {
    const mapState = phase.kind === 'prep-confirm' ? phase.state : phase;
    const isYourTurn = turnAt(mapState.cursorFen) === repertoire.color;
    const sanLine = renderSanFromEdges(mapState.path);
    return (
      <>
      {onBack && (
        <div className="subview-back-row">
          <button onClick={onBack}>Back</button>
        </div>
      )}
      <div className="layout training-layout">
        <div>
          <div className="training-scope-label">{scopeLabel}</div>
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
              <button onClick={() => { setPhase({ kind: 'setup' }); onPrepMapFinished?.(); }}>Stop mapping</button>
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
            readyLines={readyLines}
            edges={allEdges}
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
      </>
    );
  }

  if (phase.kind === 'generating' || phase.kind === 'line-ready') {
    const loadingCard = chooseLoadingHistoryCard(loadingHistoryProgress);
    return (
      <div className="layout">
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <div className="eyebrow">{scopeLabel}</div>
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
            arrows={edge ? [{ startSquare: edge.uci.slice(0, 2), endSquare: edge.uci.slice(2, 4), color: 'rgba(212,173,105,0.72)' }] : []}
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
    const currentDisplayIdx = phase.sub === 'good-flash' ? phase.cursorIdx + 1 : phase.cursorIdx;
    const viewIdx = Math.max(0, Math.min(phase.line.fullPath.length, lineViewIdx ?? currentDisplayIdx));
    const viewingCurrentPrompt = viewIdx === currentDisplayIdx;
    const viewedLastMove = viewIdx > 0 ? phase.line.fullPath[viewIdx - 1] ?? null : null;
    const viewedPromptMove = viewIdx < phase.line.fullPath.length ? phase.line.fullPath[viewIdx] ?? null : null;
    const arrows = [
      ...(viewingCurrentPrompt && showHintArrow
        ? [{ startSquare: cur.uci.slice(0, 2), endSquare: cur.uci.slice(2, 4), color: 'rgba(212,173,105,0.95)' }]
        : []),
      ...(!viewingCurrentPrompt && viewedPromptMove
        ? [{ startSquare: viewedPromptMove.uci.slice(0, 2), endSquare: viewedPromptMove.uci.slice(2, 4), color: 'rgba(212,173,105,0.72)' }]
        : []),
      ...(viewingCurrentPrompt && queuedPremove
        ? [{ startSquare: queuedPremove.from, endSquare: queuedPremove.to, color: 'rgba(240,180,45,0.9)' }]
        : []),
    ];
    const boardFen = viewIdx === 0 ? cur.parentFen : phase.line.fullPath[viewIdx - 1]?.childFen ?? cur.parentFen;
    const flashClass = viewingCurrentPrompt
      ? phase.sub === 'good-flash' ? 'board-flash-good' : phase.sub === 'bad-flash' ? 'board-flash-bad' : undefined
      : undefined;
    const turn = turnAt(boardFen);
    const pillStates = computePillStates(phase, repertoire.color, viewIdx);
    const sanLineUpToHere = renderSanFromEdges(phase.line.fullPath.slice(0, viewIdx));
    const sourceEdge = findSourceEdge(phase.line.fullPath, phase.cursorIdx, repertoire.color);
    const canHint = viewingCurrentPrompt && phase.sub === 'await' && isYour;

    return (
      <div className="layout training-layout">
        <div>
          <div className="training-scope-label">{scopeLabel}</div>
          <div className="training-board-shell">
            <Board
              fen={boardFen}
              orientation={orientation}
              onMove={(m) => {
                if (viewingCurrentPrompt && phase.sub === 'await' && isYour) {
                  const valid = applyMove(cur.parentFen, m);
                  if (!valid) return false;
                  void attemptUserMove(m);
                  return true;
                }
                if (viewingCurrentPrompt && premoveTarget && applyMove(premoveTarget.parentFen, m)) {
                  setQueuedPremove(m);
                }
                return false;
              }}
              allowMoves={viewingCurrentPrompt && ((phase.sub === 'await' && isYour) || !!premoveTarget)}
              allowedDragColor={repertoire.color}
              arrows={arrows}
              highlights={viewedLastMove ? lastMoveHighlights(viewedLastMove) : undefined}
              flashClass={flashClass}
              size={boardSize}
              resizable
              onSizeChange={onBoardSizeChange}
              historyIndex={viewIdx}
              historyLength={phase.line.fullPath.length}
              onHistoryIndexChange={setLineViewIdx}
            />
            <div className="training-board-actions">
              <button onClick={revealCurrentHint} disabled={!canHint}>Hint</button>
              <button className="danger" onClick={() => setPhase({ kind: 'done', mode: phase.mode })}>End session</button>
            </div>
          </div>
          <ProgressPills states={pillStates} />
          <div className="row" style={{ marginTop: 10 }}>
            <span className="muted small">
              {phase.kind === 'walkthrough' ? 'Walkthrough' : `Test pass ${phase.passNumber}`} · {turn === 'w' ? 'White' : 'Black'} to move
            </span>
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
          <div className="panel">
            <h3>Session</h3>
            <div className="small">
              Learn — Passed {stats.learnPassed} · Failed {stats.learnFailed}
              {stats.switched > 0 && ` · Switched ${stats.switched}`}
            </div>
          </div>
          <SourceGamePanel edge={sourceEdge} line={phase.line.fullPath} color={repertoire.color} />
          {showDebugInfo && (
            <SelectionDetailsPanel
              line={phase.line}
              repertoire={repertoire}
              currentScopeKey={currentScopeKey}
              openingScope={selectedPrepOpening}
              frontierQueue={frontierQueue}
              boardFen={boardFen}
              cursorIdx={phase.cursorIdx}
              viewIdx={viewIdx}
              trace={genTrace}
            />
          )}
        </div>
      </div>
    );
  }

  if (phase.kind === 'review' && phase.plan && phase.segmentIdx !== undefined && phase.contextPlyIdx !== undefined) {
    // SEGMENTED (line-aware) review — Chessable-style delivery.
    const plan = phase.plan;
    const seg = plan.segments[phase.segmentIdx];
    if (!seg) return null;
    const plyIdx = phase.contextPlyIdx;
    const atPrompt = isAtPromptNowInSegmentedReview(phase);
    const promptEdge = atPrompt ? seg.path[plyIdx] : null;
    // Board FEN: during good-flash on a prompt, show the move applied (childFen).
    // Otherwise show the position before the move at `plyIdx` plays.
    const boardFen = phase.sub === 'good-flash' && plyIdx > 0
      ? seg.path[plyIdx - 1]?.childFen ?? seg.rootFen
      : (phase.sub === 'good-flash' && atPrompt && promptEdge
          ? promptEdge.childFen
          : (plyIdx === 0 ? seg.rootFen : seg.path[plyIdx - 1]?.childFen ?? seg.rootFen));
    const flashClass = phase.sub === 'good-flash' ? 'board-flash-good' : phase.sub === 'bad-flash' ? 'board-flash-bad' : undefined;
    const lastMoveEdge = plyIdx > 0 ? seg.path[plyIdx - 1] ?? null : null;
    const lastMoveHighlightsForReview = lastMoveEdge ? lastMoveHighlights(lastMoveEdge) : undefined;
    const arrows = atPrompt && promptEdge && phase.sub === 'await' && phase.wrongCount >= HINT_AFTER_WRONG_COUNT
      ? [{ startSquare: promptEdge.uci.slice(0, 2), endSquare: promptEdge.uci.slice(2, 4), color: 'rgba(212,173,105,0.95)' }]
      : [];
    const sanLineSoFar = renderSanFromEdges(seg.path.slice(0, plyIdx));
    const segmentLabel = describeSegmentLabel(seg);
    const promptsRemaining = atPrompt
      ? seg.prompts.length - (phase.promptIdxInSegment ?? seg.prompts.length)
      : Math.max(0, seg.prompts.length - (phase.promptIdxInSegment ?? seg.prompts.length));
    const cardForStats = atPrompt && promptEdge ? promptEdge : null;
    return (
      <div className="layout training-layout">
        <div>
          <div className="training-scope-label">{scopeLabel}</div>
          <div className="training-board-shell">
            <Board
              fen={boardFen}
              orientation={orientation}
              onMove={(m) => {
                if (!atPrompt) return false;
                if (phase.sub !== 'await') return false;
                if (!promptEdge) return false;
                const valid = applyMove(promptEdge.parentFen, m);
                if (!valid) return false;
                void attemptSegmentedReviewMove(m);
                return true;
              }}
              allowMoves={atPrompt && phase.sub === 'await'}
              allowedDragColor={repertoire.color}
              arrows={arrows}
              highlights={lastMoveHighlightsForReview}
              flashClass={flashClass}
              size={boardSize}
              resizable
              onSizeChange={onBoardSizeChange}
            />
            <div className="training-board-actions">
              <button onClick={revealCurrentHint} disabled={!atPrompt || phase.sub !== 'await'}>Hint</button>
              <button className="danger" onClick={() => setPhase({ kind: 'done', mode: phase.mode })}>End session</button>
            </div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="muted small">
              {atPrompt ? 'Your move — play the stored reply.' : 'Playing through context…'}
              {' · '}
              Segment {phase.segmentIdx + 1}/{plan.segments.length} · Prompt {Math.min((phase.promptIdxInSegment ?? 0) + (atPrompt ? 1 : 0), seg.prompts.length)} of {seg.prompts.length} ({promptsRemaining} left)
            </span>
            <span className="spacer" />
            <button onClick={handleSkipSegmentedReview} disabled={!atPrompt || phase.sub !== 'await'}>Skip</button>
          </div>
        </div>
        <div>
          {atPrompt && phase.sub === 'await' && (
            <div className="train-feedback" style={{ background: 'transparent', borderColor: 'var(--border)', color: 'var(--text)' }}>
              Play the stored move for this position.
            </div>
          )}
          {!atPrompt && (
            <div className="train-feedback" style={{ background: 'transparent', borderColor: 'var(--border)', color: 'var(--text-dim)' }}>
              Auto-playing the line…
            </div>
          )}
          <div className="panel">
            <h3>Reviewing</h3>
            <div className="small">{segmentLabel}</div>
            <div className="mono small" style={{ marginTop: 4 }}>{sanLineSoFar || '(start)'}</div>
          </div>
          {cardForStats && <SrsCardPanel edge={cardForStats} />}
          <div className="panel">
            <h3>Session</h3>
            <div className="small">Review — Passed {stats.reviewPassed} · Failed {stats.reviewFailed} · Skipped {stats.reviewSkipped}</div>
            <div className="muted small" style={{ marginTop: 4 }}>
              {plan.totalPrompts} prompts across {plan.segments.length} segments · {plan.totalContextPlies} context plies
            </div>
            <button
              className="ghost small"
              style={{ marginTop: 8 }}
              onClick={() => void copyReviewSessionReport(phase, repertoire, scopedFolder, currentScopeKey)}
            >
              Copy review-session report
            </button>
          </div>
          {cardForStats && <SourceGamePanel edge={cardForStats} line={[cardForStats]} color={repertoire.color} />}
        </div>
      </div>
    );
  }

  if (phase.kind === 'review') {
    // LEGACY flat-queue review (plan absent — line-aware disabled or planner failed).
    const card = phase.queue[phase.idx];
    if (!card) return null;
    const boardFen = phase.sub === 'good-flash' ? card.childFen : card.parentFen;
    const flashClass = phase.sub === 'good-flash' ? 'board-flash-good' : phase.sub === 'bad-flash' ? 'board-flash-bad' : undefined;
    const lastMoveHighlightsForReview = phase.sub === 'good-flash' ? lastMoveHighlights(card) : undefined;
    return (
      <div className="layout training-layout">
        <div>
          <div className="training-scope-label">{scopeLabel}</div>
          <div className="training-board-shell">
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
                ? [{ startSquare: card.uci.slice(0, 2), endSquare: card.uci.slice(2, 4), color: 'rgba(212,173,105,0.95)' }]
                : []}
              highlights={lastMoveHighlightsForReview}
              flashClass={flashClass}
              size={boardSize}
              resizable
              onSizeChange={onBoardSizeChange}
            />
            <div className="training-board-actions">
              <button onClick={revealCurrentHint} disabled={phase.sub !== 'await'}>Hint</button>
              <button className="danger" onClick={() => setPhase({ kind: 'done', mode: phase.mode })}>End session</button>
            </div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="muted small">Review {phase.idx + 1} / {phase.queue.length}</span>
            <span className="spacer" />
            <button onClick={handleSkipReview} disabled={phase.sub !== 'await'}>Skip</button>
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
            <div className="small">
              <div>Reps: {card.reps} · Lapses: {card.lapses}</div>
              <div>Ease: {card.ease.toFixed(2)} · Interval: {card.intervalDays}d</div>
            </div>
          </div>
          <div className="panel">
            <h3>Session</h3>
            <div className="small">Review — Passed {stats.reviewPassed} · Failed {stats.reviewFailed} · Skipped {stats.reviewSkipped}</div>
          </div>
          <SourceGamePanel edge={card} line={[card]} color={repertoire.color} />
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

// Eval display convention: ALWAYS white-positive. + means good for White,
// − means good for Black, regardless of the repertoire's color. Past bug: the
// panel flipped sign with pvCpForColor, which made it easy to misread evals
// when training a Black repertoire. The internal mistake-detection elsewhere
// (autosuggest.evaluateMoveCpLoss) still uses side-of-color; only the display
// in this panel is white-positive. The evaluated FEN is shown beneath each
// number so any FEN/board mismatch is immediately visible.
function LineEvalPanel({ line, currentFen, color }: { line: Edge[]; currentFen: string; color: Repertoire['color'] }) {
  const [currentEval, setCurrentEval] = useState<number | null | undefined>(undefined);
  const [finalEval, setFinalEval] = useState<number | null | undefined>(undefined);
  // Track which FEN each value was fetched for, so we never display a number
  // that belongs to a different position. A stale value (FEN doesn't match the
  // current prop) is treated as unavailable until the new fetch completes.
  const [currentEvalFen, setCurrentEvalFen] = useState<string | null>(null);
  const [finalEvalFen, setFinalEvalFen] = useState<string | null>(null);
  const finalFen = line[line.length - 1]?.childFen ?? currentFen;
  const mistakeEdge = line.find(edge => edge.mover !== color && edge.isMistake);

  useEffect(() => {
    let cancelled = false;
    setCurrentEval(undefined);
    setFinalEval(undefined);
    setCurrentEvalFen(null);
    setFinalEvalFen(null);
    (async () => {
      const [current, final] = await Promise.all([
        evalForWhite(currentFen),
        finalFen === currentFen ? Promise.resolve(null) : evalForWhite(finalFen),
      ]);
      if (cancelled) return;
      setCurrentEval(current);
      setCurrentEvalFen(currentFen);
      setFinalEval(finalFen === currentFen ? current : final);
      setFinalEvalFen(finalFen);
    })();
    return () => { cancelled = true; };
  }, [currentFen, finalFen]);

  const currentStale = currentEvalFen !== null && currentEvalFen !== currentFen;
  const finalStale = finalEvalFen !== null && finalEvalFen !== finalFen;

  return (
    <div className={'panel line-eval-panel' + (mistakeEdge ? ' punishing' : '')}>
      <h3>Engine eval</h3>
      <div className="muted small">White's perspective: + = good for White, − = good for Black.</div>
      <div className="line-eval-kind">
        {mistakeEdge ? 'Punishing opponent mistake' : 'Continuing the line'}
      </div>
      {mistakeEdge && (
        <div className="muted small">Opponent move: <span className="mono">{mistakeEdge.san}</span></div>
      )}
      <div className="line-eval-grid">
        <div>
          <span className="muted small">Current</span>
          <strong>{formatEval(currentStale ? undefined : currentEval)}</strong>
          <div className="muted small mono" style={{ fontSize: 10, wordBreak: 'break-all', marginTop: 2 }}>
            {currentFen}
          </div>
        </div>
        <div>
          <span className="muted small">Line end</span>
          <strong>{formatEval(finalStale ? undefined : finalEval)}</strong>
          <div className="muted small mono" style={{ fontSize: 10, wordBreak: 'break-all', marginTop: 2 }}>
            {finalFen}
          </div>
        </div>
      </div>
    </div>
  );
}

// Cloud eval, always returned from White's perspective (no color flip).
async function evalForWhite(fen: string): Promise<number | null> {
  try {
    const evaluation = await fetchCloudEval(fen, 1, TUNING.engineDepthGate);
    if (!evaluation || evaluation.pvs.length === 0) return null;
    return pvCpForWhite(evaluation.pvs[0]);
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

// Surfaces the build worker's state to the user. Shows:
//   - ready  → lines already built and persisted in IndexedDB, awaiting Train click
//   - working → the worker is currently building a line
// Open frontier candidates are shown in FrontierQueuePanel, not as generated lines.
// Scoped to the currently selected opening folder. When no folder is selected, the
// scope is the whole repertoire (rootFen).
function LineQueuePanel({ openingLabel, readyLines, workerStatus }: {
  openingLabel: string;
  readyLines: ReadyLine[];
  workerStatus: 'paused' | 'idle' | 'working' | 'error';
}) {
  const cap = TUNING.readyLineCap;
  type Row =
    | { kind: 'ready'; line: ReadyLine }
    | { kind: 'working' };
  const rows: Row[] = readyLines.map(line => ({ kind: 'ready' as const, line }));
  const includeWorking = workerStatus === 'working' && rows.length < cap;
  if (includeWorking) rows.push({ kind: 'working' });
  const statusBlurb = {
    paused:  'Worker paused. Start a training session to fill the queue.',
    idle:    `Worker idle. Cache holds ${readyLines.length} of ${cap} ready lines.`,
    working: `Worker building a new line. Cache holds ${readyLines.length} of ${cap}.`,
    error:   'Worker hit an error. Check the generation trace for details.',
  }[workerStatus];
  return (
    <div className="frontier-queue">
      <div className="frontier-queue-head">
        <div>
          <h3>Generated Line Queue ({openingLabel})</h3>
          <div className="muted small">{statusBlurb}</div>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="muted small frontier-empty">
          No generated lines are ready yet. Open frontier candidates are shown in the Frontier Index debug table.
        </div>
      ) : (
        <div className="frontier-table frontier-line-table" role="table" aria-label="Generated line queue">
          <div className="frontier-row frontier-row-head" role="row">
            <span>Status</span>
            <span>Line preview</span>
            <span>Drop</span>
            <span>Built</span>
          </div>
          {rows.map((row, idx) => {
            if (row.kind === 'ready') {
              const dropStr = row.line.qualityDropCp == null ? '—' : `${(row.line.qualityDropCp / 100).toFixed(2)}`;
              const age = formatRelativeAge(row.line.createdAt);
              return (
                <div className="frontier-row" role="row" key={row.line.id}>
                  <span className="frontier-status frontier-status-ready">ready</span>
                  <span className="mono small">{row.line.previewSan || '(no preview)'}</span>
                  <span className="small">{dropStr}</span>
                  <span className="muted small">{age}</span>
                </div>
              );
            }
            return (
              <div className="frontier-row" role="row" key={`working-${idx}`}>
                <span className="frontier-status frontier-status-open">working</span>
                <span className="muted small">Building next line...</span>
                <span>-</span>
                <span>-</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatRelativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

// Bidirectional "Xm ago" / "in Xm" formatter for the SRS panel — needs to handle
// dueAt timestamps that are in the future after a pass.
function formatRelativeFromNow(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  const abs = Math.abs(ms);
  let label: string;
  if (abs < 60_000) label = 'now';
  else if (abs < 3_600_000) label = `${Math.floor(abs / 60_000)}m`;
  else if (abs < 86_400_000) label = `${Math.floor(abs / 3_600_000)}h`;
  else label = `${Math.floor(abs / 86_400_000)}d`;
  if (label === 'now') return 'now';
  return ms >= 0 ? `in ${label}` : `${label} ago`;
}

// Per-card SRS state panel rendered during segmented review. Shows the prompt
// edge's current SM-2 state plus a preview of where dueAt and ease will land
// if the user passes vs fails this prompt. Read-only — the actual grading still
// happens in attemptSegmentedReviewMove. See docs/srs.md for the algorithm.
function SrsCardPanel({ edge }: { edge: Edge }) {
  const now = useMemo(() => new Date(), [edge.id, edge.dueAt, edge.lastReviewedAt]);
  const passPreview = useMemo(() => gradePass(edge, now), [edge, now]);
  const failPreview = useMemo(() => gradeFail(edge, now), [edge, now]);
  const dueNow = isDue(edge, now);
  return (
    <div className="panel srs-card-panel">
      <h3>SRS state</h3>
      <div className="srs-card-row small">
        <span>Due</span>
        <span className="mono">{formatRelativeFromNow(edge.dueAt, now.getTime())}{dueNow ? ' (now)' : ''}</span>
      </div>
      <div className="srs-card-row small">
        <span>Last reviewed</span>
        <span className="mono">{edge.lastReviewedAt ? formatRelativeFromNow(edge.lastReviewedAt, now.getTime()) : 'never'}</span>
      </div>
      <div className="srs-card-row small">
        <span>Reps · Lapses</span>
        <span className="mono">{edge.reps} · {edge.lapses}</span>
      </div>
      <div className="srs-card-row small">
        <span>Ease · Interval</span>
        <span className="mono">{edge.ease.toFixed(2)} · {edge.intervalDays}d</span>
      </div>
      <div className="srs-card-divider" />
      <div className="srs-card-row small">
        <span className="muted">If you pass</span>
        <span className="mono">{formatRelativeFromNow(passPreview.dueAt, now.getTime())} · {passPreview.intervalDays}d</span>
      </div>
      <div className="srs-card-row small">
        <span className="muted">If you fail</span>
        <span className="mono">{formatRelativeFromNow(failPreview.dueAt, now.getTime())} · ease {failPreview.ease.toFixed(2)}</span>
      </div>
    </div>
  );
}

// Build a paste-ready report of the current review session — scope, plan, per-segment
// listing with prompt SRS state, current position. Mirrors the Learn-side
// buildFailureReport / SelectionDetailsPanel pattern so the user can copy and paste
// into ChatGPT/Codex for diagnosis.
function buildReviewSessionReport(
  phase: Extract<Phase, { kind: 'review' }>,
  repertoire: Repertoire,
  scopedFolder: { name: string; baseFen: NormFen } | null,
  currentScopeKey: string | null,
): string {
  const lines: string[] = [];
  lines.push('=== Chesski Review: session report ===');
  lines.push(`Repertoire: ${repertoire.name} (id=${repertoire.id}, color=${repertoire.color})`);
  lines.push(`Scope: ${scopedFolder ? `${scopedFolder.name} (baseFen=${scopedFolder.baseFen})` : 'whole repertoire'}`);
  lines.push(`currentScopeKey: ${currentScopeKey ?? '(none)'}`);
  lines.push(`Session mode: ${phase.mode}`);
  lines.push(`Delivery: ${phase.plan ? 'segmented (line-aware)' : 'flat (legacy)'}`);
  lines.push('');

  if (phase.plan) {
    const plan = phase.plan;
    lines.push('--- Plan ---');
    lines.push(`Segments: ${plan.segments.length} · Total prompts: ${plan.totalPrompts} · Total context plies: ${plan.totalContextPlies}`);
    if (plan.droppedCards.length > 0) {
      lines.push(`Dropped cards (no path from scope root): ${plan.droppedCards.length}`);
    }
    lines.push('');
    lines.push('--- Current position ---');
    lines.push(`segmentIdx: ${phase.segmentIdx ?? 0} / ${plan.segments.length}`);
    lines.push(`contextPlyIdx: ${phase.contextPlyIdx ?? 0}`);
    lines.push(`promptIdxInSegment: ${phase.promptIdxInSegment ?? 0}`);
    lines.push(`sub: ${phase.sub} · wrongCount: ${phase.wrongCount} · sameWrongCount: ${phase.sameWrongCount}`);
    lines.push(`Graded so far this session (${(phase.gradedPromptEdgeIds ?? []).length} edges): ${(phase.gradedPromptEdgeIds ?? []).join(', ') || '(none)'}`);
    lines.push('');
    lines.push('--- Segments ---');
    plan.segments.forEach((seg, idx) => {
      lines.push(`[Segment ${idx + 1}] ${seg.segmentId} · rootFen=${seg.rootFen}`);
      lines.push(`  Path length: ${seg.path.length} · Prompts: ${seg.prompts.length}`);
      seg.prompts.forEach((prompt, pIdx) => {
        const e = seg.path[prompt.pathIdx];
        if (!e) return;
        lines.push(
          `  · Prompt ${pIdx + 1} @ plyIdx ${prompt.pathIdx}: ${e.san} (${e.uci}) · ` +
          `reps=${e.reps} lapses=${e.lapses} ease=${e.ease.toFixed(2)} interval=${e.intervalDays}d · ` +
          `due=${e.dueAt}${e.lastReviewedAt ? ` lastReviewed=${e.lastReviewedAt}` : ''}`
        );
      });
    });
  } else {
    lines.push('--- Flat queue (legacy delivery) ---');
    lines.push(`Queue length: ${phase.queue.length} · Current idx: ${phase.idx}`);
    phase.queue.forEach((e, idx) => {
      lines.push(
        `  ${idx + 1}. ${e.san} (${e.uci}) · ` +
        `reps=${e.reps} lapses=${e.lapses} ease=${e.ease.toFixed(2)} interval=${e.intervalDays}d · ` +
        `due=${e.dueAt}`
      );
    });
  }

  return lines.join('\n');
}

async function copyReviewSessionReport(
  phase: Extract<Phase, { kind: 'review' }>,
  repertoire: Repertoire,
  scopedFolder: { name: string; baseFen: NormFen } | null,
  currentScopeKey: string | null,
): Promise<void> {
  const body = buildReviewSessionReport(phase, repertoire, scopedFolder, currentScopeKey);
  try {
    await navigator.clipboard.writeText(body);
  } catch {
    // Clipboard API can fail in non-secure contexts or denied permissions; fall back
    // to printing into the console so the user can hand-copy.
    // eslint-disable-next-line no-console
    console.log(body);
  }
}

type FrontierDisplayStatus = 'ready' | 'queued' | 'answered' | 'blocked' | 'stale';

function frontierHasGeneratedLine(frontier: FrontierCandidate, readyLines: ReadyLine[]): boolean {
  return readyLines.some(line => line.frontierId === frontier.id || line.frontierFen === frontier.childFen);
}

function frontierDisplayStatus(frontier: FrontierCandidate, readyLines: ReadyLine[]): FrontierDisplayStatus {
  if (frontierHasGeneratedLine(frontier, readyLines)) return 'queued';
  return frontier.status === 'open' ? 'ready' : frontier.status;
}

function FrontierQueuePanel({ frontiers, readyLines, edges, rebuilding, copyStatus, onRefresh, onCopy }: {
  frontiers: FrontierCandidate[];
  readyLines: ReadyLine[];
  edges: Edge[];
  rebuilding: boolean;
  copyStatus: string | null;
  onRefresh: () => void;
  onCopy: () => void;
}) {
  const storedMoveKeys = new Set(edges.map(edge => `${edge.parentFen}::${edge.uci}`));
  const rows = frontiers;
  const queued = rows.filter(frontier => frontierDisplayStatus(frontier, readyLines) === 'queued');
  const ready = rows.filter(frontier => frontierDisplayStatus(frontier, readyLines) === 'ready');
  const blocked = rows.filter(frontier => frontierDisplayStatus(frontier, readyLines) === 'blocked');
  const answered = rows.filter(frontier => frontierDisplayStatus(frontier, readyLines) === 'answered');
  return (
    <div className="frontier-queue">
      <div className="frontier-queue-head">
        <div>
          <h3>Frontier Index</h3>
          <div className="muted small">
            {rows.length} total, {ready.length} ready, {queued.length} queued, {blocked.length} blocked, {answered.length} answered. Generated Line Queue holds {readyLines.length} ready line{readyLines.length === 1 ? '' : 's'}.
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
          No indexed frontiers yet. Press Refresh list or start Learn to rebuild the index.
        </div>
      ) : (
        <div className="frontier-table frontier-index-table" role="table" aria-label="Frontier index">
          <div className="frontier-row frontier-row-head" role="row">
            <span>Status</span>
            <span>Move</span>
            <span>Source</span>
            <span>Games</span>
            <span>Weight</span>
            <span>Stored</span>
            <span>Line</span>
            <span>Child FEN</span>
            <span>Reason</span>
          </div>
          {rows.map(frontier => {
            const status = frontierDisplayStatus(frontier, readyLines);
            const stored = storedMoveKeys.has(`${frontier.parentFen}::${frontier.uci}`);
            const generated = frontierHasGeneratedLine(frontier, readyLines);
            return (
              <div className="frontier-row" role="row" key={frontier.id} title={frontier.lastReason ?? frontier.childFen}>
                <span className={`frontier-status frontier-status-${status}`}>{status}</span>
                <span className="mono">{frontier.san} <span className="muted">({frontier.uci})</span></span>
                <span>{frontier.source}</span>
                <span>{frontier.games.toLocaleString()}</span>
                <span>{frontier.weight.toFixed(5)}</span>
                <span>{stored ? 'yes' : 'no'}</span>
                <span>{generated ? 'yes' : 'no'}</span>
                <span className="mono frontier-fen">{frontier.childFen}</span>
                <span className="frontier-reason">{frontier.lastReason ?? ''}</span>
              </div>
            );
          })}
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

// "Selection details" — visible during walkthrough/test when Show debug info is on.
// Reports HOW this line was chosen so the user can paste a self-contained report
// back to ChatGPT/Codex for diagnosis. Pulls from currently in-scope data:
// the line's frontier id/fen, the frontier candidate row (for games/weight/source),
// the current scope key (for stale-scope detection), and the generation trace.
// Selection logic is in lib/autosuggest.ts:findTopUnansweredOpponentMove — this
// panel only renders, it does not influence selection.
function SelectionDetailsPanel({ line, repertoire, currentScopeKey, openingScope, frontierQueue, boardFen, cursorIdx, viewIdx, trace }: {
  line: GeneratedLine;
  repertoire: Repertoire;
  currentScopeKey: string | null;
  openingScope: { key: string; name: string; moves: string[] } | null;
  frontierQueue: FrontierCandidate[];
  boardFen: string;
  cursorIdx: number;
  viewIdx: number;
  trace: string[];
}) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const frontierCandidate = useMemo(
    () => line.frontierId ? frontierQueue.find(f => f.id === line.frontierId) ?? null : null,
    [line.frontierId, frontierQueue]
  );
  const lineScopeKey = frontierCandidate?.scopeKey ?? null;
  const scopeMatch = lineScopeKey === currentScopeKey;
  const finalFen = line.fullPath[line.fullPath.length - 1]?.childFen ?? boardFen;
  const sourceEdge = line.fullPath.slice(line.generationStartIndex).find(e => e.sourcePlayerName || e.sourceGameName) ?? null;

  function buildLineReport(): string {
    const head = [
      `=== Chesski Train: line selection report ===`,
      `Repertoire: ${repertoire.name} (${repertoire.id}, color=${repertoire.color}, root=${repertoire.rootFen})`,
      `Opening folder: ${openingScope ? `${openingScope.key} (${openingScope.name})` : 'entire repertoire'}`,
      `currentScopeKey: ${currentScopeKey ?? '(null)'}`,
      ``,
      `--- Selected frontier ---`,
      `selectionReason: ${line.selectionReason ?? '(unknown)'}`,
      `frontierId: ${line.frontierId ?? '(none)'}`,
      `frontierFen: ${line.frontierFen ?? '(none)'}`,
      frontierCandidate
        ? [
            `games (sort key): ${frontierCandidate.games}`,
            `weight (display only, not used for selection): ${frontierCandidate.weight.toFixed(5)}`,
            `popularityFraction: ${frontierCandidate.popularityFraction.toFixed(3)}`,
            `source: ${frontierCandidate.source}`,
            `frontier path plies (root→frontier): ${frontierCandidate.path.length}`,
            `frontier scopeKey: ${frontierCandidate.scopeKey}`,
            `scope match (line vs current): ${scopeMatch ? 'YES' : `NO — line=${lineScopeKey ?? '(null)'} current=${currentScopeKey ?? '(null)'}`}`,
          ].join('\n')
        : `(frontier candidate not found in current queue — may have been answered/cleared after selection, or this is a cache-hit/stockfish-fallback line)`,
      ``,
      `--- Line structure ---`,
      `fullPath length (plies, root→end): ${line.fullPath.length}`,
      `generationStartIndex (frontier index in fullPath): ${line.generationStartIndex}`,
      `extension plies past frontier: ${line.fullPath.length - line.generationStartIndex}`,
      `newEdges created this session: ${line.newEdges.length}`,
      ``,
      `--- Source game (first sourced edge after frontier) ---`,
      sourceEdge
        ? [
            `player: ${sourceEdge.sourcePlayerName ?? '(unknown)'}`,
            `game: ${sourceEdge.sourceGameName ?? '(unknown)'}`,
            `record: ${sourceEdge.sourceWins ?? 0}W ${sourceEdge.sourceDraws ?? 0}D ${sourceEdge.sourceLosses ?? 0}L · net ${sourceEdge.sourceNet ?? 0}`,
          ].join('\n')
        : '(none — line was not generated from a named player game)',
      ``,
      `--- Cursor / displayed FEN ---`,
      `cursorIdx: ${cursorIdx}`,
      `viewIdx (board is showing): ${viewIdx}`,
      `boardFen (live, evaluated): ${boardFen}`,
      `finalFen (line-end, evaluated): ${finalFen}`,
      ``,
      `--- Generation trace (${trace.length} events) ---`,
      trace.length === 0 ? '(empty — likely a cache-hit line, original generation trace was not retained)' : trace.join('\n'),
    ].join('\n');
    return head;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(buildLineReport());
      setCopyStatus('Copied line report');
    } catch {
      setCopyStatus('Copy failed; expand the report below and copy from the textarea');
    }
  }

  return (
    <div className="panel" style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Selection details (debug)</h3>
        <button className="small" onClick={() => void copy()}>Copy line report</button>
      </div>
      {copyStatus && <div className="muted small" style={{ marginTop: 4 }}>{copyStatus}</div>}
      <div className="small" style={{ marginTop: 6, lineHeight: 1.5 }}>
        <div><strong>Origin:</strong> <span className="mono">{line.selectionReason ?? 'unknown'}</span></div>
        <div><strong>Scope match:</strong> {scopeMatch ? <span style={{ color: 'var(--good)' }}>✓</span> : <span style={{ color: 'var(--bad)' }}>✗ stale</span>}</div>
        <div><strong>Frontier ply (root→frontier):</strong> {frontierCandidate ? frontierCandidate.path.length : '(n/a)'}</div>
        <div><strong>Total line plies:</strong> {line.fullPath.length} ({line.fullPath.length - line.generationStartIndex} past frontier)</div>
        {frontierCandidate && (
          <>
            <div><strong>games (sort key):</strong> {frontierCandidate.games.toLocaleString()}</div>
            <div><strong>weight (display only):</strong> {frontierCandidate.weight.toFixed(5)}</div>
            <div><strong>source:</strong> {frontierCandidate.source}</div>
          </>
        )}
      </div>
      <details style={{ marginTop: 6 }}>
        <summary className="muted small" style={{ cursor: 'pointer' }}>Show full report (paste-ready)</summary>
        <textarea
          readOnly
          value={buildLineReport()}
          className="mono"
          aria-label="Line selection report"
          style={{ width: '100%', minHeight: 200, marginTop: 4, fontSize: 11 }}
        />
      </details>
    </div>
  );
}

function LoadingHistoryCard({ cardState, answerShown, onToggleAnswer, onGrade }: {
  cardState: HistoryCardState;
  answerShown: boolean;
  onToggleAnswer: () => void;
  onGrade: (knewIt: boolean) => void;
}) {
  return (
    <div className="cloze-card">
      <div className="muted small">While Chesski builds the line</div>
      <ClozePrompt card={cardState.card} answerShown={answerShown} onToggleAnswer={onToggleAnswer} />
      <div className="row history-actions">
        <button className="primary" onClick={() => onGrade(true)}>Knew it</button>
        <button onClick={() => onGrade(false)}>Couldn't pull it</button>
      </div>
    </div>
  );
}

// Short human label for a review segment: first few plies in SAN, capped at
// 6 plies so the label stays one short line. Used in the segmented review
// "Reviewing" panel header.
function describeSegmentLabel(segment: ReviewPlan['segments'][number]): string {
  const head = segment.path.slice(0, 6);
  const rest = segment.path.length > head.length ? ` …(${segment.path.length} plies)` : '';
  return renderSanFromEdges(head) + rest;
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

function computePillStates(phase: Phase, color: Repertoire['color'], displayCursorIdx?: number): PillState[] {
  if (phase.kind !== 'walkthrough' && phase.kind !== 'test') return [];
  // Pills represent the user's NEW your-color moves (i.e., newEdges that are your color).
  const yourNewEdges = phase.line.newEdges.filter(e => isTrainableEdge(e, color));
  // The cursor tells us which of those is currently being interacted with.
  const cursorIdx = displayCursorIdx ?? phase.cursorIdx;
  const cur = cursorIdx < phase.line.fullPath.length ? phase.line.fullPath[cursorIdx] : null;
  return yourNewEdges.map(e => {
    if (cur && e.id === cur.id) return 'current';
    // Did the cursor pass it already?
    const idxOfE = phase.line.fullPath.findIndex(x => x.id === e.id);
    if (idxOfE >= 0 && idxOfE < cursorIdx) {
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
