import { Component, useEffect, useRef, useState, useCallback, type Dispatch, type SetStateAction, type ReactNode } from 'react';
import { TrainMode } from './modes/TrainMode';
import { BrowseMode } from './modes/BrowseMode';
import { ReviewMode } from './modes/ReviewMode';
import { NewOpeningMode } from './modes/NewOpeningMode';
import { GameImportMode } from './modes/GameImportMode';
import { AccountMode } from './modes/AccountMode';
import { SettingsMode } from './modes/SettingsMode';
import { AlgorithmMode } from './modes/AlgorithmMode';
import { Board } from './components/Board';
import { TokenModal } from './components/TokenModal';
import { BoardPreferencesProvider } from './lib/boardPreferences';
import { TrainingPreferencesProvider } from './lib/trainingPreferences';
import { getCurrentAccount, restoreCurrentAccount, runStartupMigrations, syncCurrentAccount } from './lib/accounts';
import {
  exportAll, importAll, type ExportData,
  listRepertoires, createRepertoire, createRepertoireFromFen,
  createRepertoireFromPgn, cloneRepertoire,
  getEdgesByMover, getEdgesForRepertoire, setMeta, getMeta,
  CURATED_OPENINGS, deleteOpeningFolderInRepertoire, ensureDefaultMainRepertoires,
  getRepertoire, addMovesToRepertoire, markCuratedOpeningScaffolds,
  deleteRepertoire, updateRepertoire,
} from './lib/storage';
import { getLichessToken } from './lib/lichess';
import { isDue } from './lib/srs';
import { listOpeningFoldersForRepertoire, type OpeningFolder } from './lib/openingFolders';
import {
  applyOnboardingSourcePreset,
  completeFirstRunOnboarding,
  getFirstRunOnboardingState,
  ONBOARDING_SOURCE_PRESETS,
  restartFirstRunOnboarding,
  type OnboardingSourcePresetKey,
} from './lib/onboarding';
import { prepareOpeningLineForRepertoire } from './lib/openingRoots';
import type { Color, Edge, Repertoire } from './types';
import type { AlgorithmScope } from './lib/recommendationSettings';

type Tab = 'home' | 'train' | 'browse' | 'games' | 'new-opening' | 'repertoires' | 'settings' | 'account' | 'algorithm';
type OnboardingStep = 'welcome' | 'side' | 'opening' | 'source' | 'mapping' | 'finish';
type OnboardingDraft = {
  step: OnboardingStep;
  color: Color | null;
  openingKey: string | null;
  sourcePreset: OnboardingSourcePresetKey;
};
const META_LAST_REP = 'last_repertoire_id';
const META_BOARD_SIZE = 'board_size';
const META_REPERTOIRE_ORDER = 'repertoire_order';
const DEFAULT_BOARD_SIZE = 640;

function sortRepertoiresBySavedOrder(list: Repertoire[], order: string[] | null | undefined): Repertoire[] {
  if (!order || order.length === 0) return list;
  const orderIndex = new Map(order.map((id, idx) => [id, idx]));
  return [...list].sort((a, b) => {
    const aRank = orderIndex.get(a.id);
    const bRank = orderIndex.get(b.id);
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
    if (aRank !== undefined) return -1;
    if (bRank !== undefined) return 1;
    return list.indexOf(a) - list.indexOf(b);
  });
}

function AppContent() {
  const [tab, setTab] = useState<Tab>('repertoires');
  const [refreshKey, setRefreshKey] = useState(0);
  const [dueCount, setDueCount] = useState(0);
  const [repertoires, setRepertoires] = useState<Repertoire[]>([]);
  const [activeRepId, setActiveRepId] = useState<string | null>(null);
  const [activeOpeningKey, setActiveOpeningKey] = useState<string | null>(null);
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [showFirstRunOnboarding, setShowFirstRunOnboarding] = useState(false);
  const [onboardingDraft, setOnboardingDraft] = useState<OnboardingDraft>({ step: 'welcome', color: null, openingKey: null, sourcePreset: 'default' });
  const [starterNotice, setStarterNotice] = useState(false);
  const [importNotice, setImportNotice] = useState(false);
  const [trainingSessionActive, setTrainingSessionActive] = useState(false);
  const [prepMapRequest, setPrepMapRequest] = useState<{ repId: string; openingKey: string; nonce: number } | null>(null);
  const [trainingStartRequest, setTrainingStartRequest] = useState<{ repId: string; openingKey: string | null; nonce: number } | null>(null);
  const [algorithmTarget, setAlgorithmTarget] = useState<{ scope: AlgorithmScope; title: string; parentTitle?: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const accountSyncTimerRef = useRef<number | null>(null);

  // Token gating
  const [tokenChecked, setTokenChecked] = useState(false);
  const [hasToken, setHasToken] = useState(false);

  // Board size (persisted in meta)
  const [boardSize, setBoardSize] = useState<number>(DEFAULT_BOARD_SIZE);

  const activeRep = repertoires.find(r => r.id === activeRepId) ?? null;

  // Initial load
  useEffect(() => {
    (async () => {
      await runStartupMigrations();
      const tok = await getLichessToken();
      setHasToken(!!tok);
      setTokenChecked(true);
      const sizeRaw = await getMeta<number>(META_BOARD_SIZE);
      if (typeof sizeRaw === 'number') setBoardSize(sizeRaw);
    })();
  }, []);

  // Persist board size whenever it changes (after initial load).
  useEffect(() => {
    if (!tokenChecked) return;
    document.documentElement.style.setProperty('--board-col', boardSize + 'px');
    void setMeta(META_BOARD_SIZE, boardSize);
  }, [boardSize, tokenChecked]);

  const refreshDueCount = useCallback(async () => {
    if (!activeRep) { setDueCount(0); return; }
    const edges = await getEdgesByMover(activeRep.id, activeRep.color);
    const now = new Date();
    setDueCount(edges.filter(e => isDue(e, now)).length);
  }, [activeRep]);


  const reloadRepertoires = useCallback(async () => {
    let list = await listRepertoires();
    if (list.length === 0) {
      const currentAccount = await getCurrentAccount();
      if (currentAccount?.hasSnapshot) {
        await restoreCurrentAccount();
        list = await listRepertoires();
      }
    }
    if (list.length === 0) {
      list = await ensureDefaultMainRepertoires();
    }
    const savedOrder = await getMeta<string[]>(META_REPERTOIRE_ORDER);
    list = sortRepertoiresBySavedOrder(list, savedOrder);
    setRepertoires(list);
    if (list.length === 0) {
      setActiveRepId(null);
      setActiveOpeningKey(null);
      return list;
    }
    if (activeRepId && list.some(r => r.id === activeRepId)) return list;
    const lastId = await getMeta<string>(META_LAST_REP);
    const fallback = lastId && list.some(r => r.id === lastId) ? lastId : list[0].id;
    setActiveRepId(fallback);
    return list;
  }, [activeRepId]);

  useEffect(() => { if (hasToken) void reloadRepertoires(); }, [reloadRepertoires, hasToken]);
  useEffect(() => { void refreshDueCount(); }, [refreshDueCount, refreshKey]);

  useEffect(() => {
    if (!hasToken || !tokenChecked || onboardingChecked || repertoires.length === 0) return;
    let cancelled = false;
    (async () => {
      const state = await getFirstRunOnboardingState();
      if (cancelled) return;
      setShowFirstRunOnboarding(state === 'pending');
      setOnboardingChecked(true);
    })();
    return () => { cancelled = true; };
  }, [hasToken, tokenChecked, onboardingChecked, repertoires.length]);

  useEffect(() => {
    if (activeRepId) void setMeta(META_LAST_REP, activeRepId);
  }, [activeRepId]);

  const scheduleAccountSync = useCallback(() => {
    if (accountSyncTimerRef.current !== null) window.clearTimeout(accountSyncTimerRef.current);
    accountSyncTimerRef.current = window.setTimeout(() => {
      accountSyncTimerRef.current = null;
      void syncCurrentAccount().catch(() => {});
    }, 900);
  }, []);

  useEffect(() => {
    return () => {
      if (accountSyncTimerRef.current !== null) window.clearTimeout(accountSyncTimerRef.current);
    };
  }, []);

  const onDataChange = useCallback(() => {
    setRefreshKey(k => k + 1);
    void refreshDueCount();
    scheduleAccountSync();
  }, [refreshDueCount, scheduleAccountSync]);

  const onAccountRestored = useCallback(() => {
    void (async () => {
      const tok = await getLichessToken();
      setHasToken(!!tok);
      await reloadRepertoires();
      setOnboardingChecked(false);
      onDataChange();
    })();
  }, [reloadRepertoires, onDataChange]);

  async function handleCreated(rep: Repertoire) {
    await reloadRepertoires();
    setActiveRepId(rep.id);
    onDataChange();
  }

  function handleOpenRepertoire(id: string, openingKey?: string | null) {
    setActiveRepId(id);
    setActiveOpeningKey(openingKey ?? null);
    setTab('train');
  }

  function handleChooseRepertoire(id: string, nextTab: Tab = 'repertoires', openingKey?: string | null) {
    setActiveRepId(id);
    setActiveOpeningKey(openingKey ?? null);
    setTab(nextTab);
  }

  function handleAddOpening(repId: string) {
    setActiveRepId(repId);
    setActiveOpeningKey(null);
    setTab('new-opening');
  }

  function handleStartOpeningPrepMap(repId: string, openingKey: string) {
    setActiveRepId(repId);
    setActiveOpeningKey(openingKey);
    setPrepMapRequest({ repId, openingKey, nonce: Date.now() });
    setTab('train');
  }

  function handleOpenGlobalAlgorithm() {
    setAlgorithmTarget({ scope: { kind: 'global' }, title: 'Algorithm: Global defaults' });
    setTab('algorithm');
  }

  function handleOpenRepertoireAlgorithm(rep: Repertoire) {
    setActiveRepId(rep.id);
    setActiveOpeningKey(null);
    setAlgorithmTarget({
      scope: { kind: 'repertoire', repertoireId: rep.id },
      title: `Algorithm: ${rep.name}`,
    });
    setTab('algorithm');
  }

  function handleOpenOpeningAlgorithm(rep: Repertoire, folder: OpeningFolder) {
    setActiveRepId(rep.id);
    setActiveOpeningKey(folder.key);
    setAlgorithmTarget({
      scope: { kind: 'opening-folder', repertoireId: rep.id, openingKey: folder.key },
      title: `Algorithm: ${rep.name} / ${folder.name}`,
      parentTitle: rep.name,
    });
    setTab('algorithm');
  }

  async function handleRestartOnboarding() {
    await restartFirstRunOnboarding();
    const list = await reloadRepertoires();
    setOnboardingDraft({ step: 'welcome', color: null, openingKey: null, sourcePreset: 'default' });
    setShowFirstRunOnboarding(true);
    setOnboardingChecked(true);
    setTab('repertoires');
    if (!activeRepId && list[0]) setActiveRepId(list[0].id);
    onDataChange();
  }

  async function handleDeleteOpeningPrep(repId: string, folder: OpeningFolder) {
    const rep = repertoires.find(r => r.id === repId);
    if (!rep) return;
    const ok = window.confirm(`Delete all prep for "${folder.name}" inside "${rep.name}"? Shared earlier moves may remain if other openings use them.`);
    if (!ok) return;
    const incoming = folder.path[folder.path.length - 1] ?? null;
    await deleteOpeningFolderInRepertoire(rep.id, folder.baseFen, incoming?.id ?? null);
    if (activeRepId === rep.id && activeOpeningKey === folder.key) setActiveOpeningKey(null);
    await reloadRepertoires();
    onDataChange();
  }

  async function handleDeleteRepertoire(id: string) {
    const rep = repertoires.find(r => r.id === id);
    if (!rep) return;
    if (!window.confirm(`Permanently delete "${rep.name}" and all its lines? This cannot be undone.`)) return;
    await deleteRepertoire(id);
    if (activeRepId === id) {
      const remaining = repertoires.filter(r => !r.archived && r.id !== id);
      setActiveRepId(remaining[0]?.id ?? null);
    }
    await reloadRepertoires();
    onDataChange();
  }

  async function handleArchiveRepertoire(id: string) {
    await updateRepertoire(id, { archived: true });
    if (activeRepId === id) {
      const remaining = repertoires.filter(r => !r.archived && r.id !== id);
      setActiveRepId(remaining[0]?.id ?? null);
    }
    await reloadRepertoires();
    onDataChange();
  }

  async function handleUnarchiveRepertoire(id: string) {
    await updateRepertoire(id, { archived: false });
    await reloadRepertoires();
    onDataChange();
  }

  async function handleRenameRepertoire(id: string, name: string) {
    if (!name.trim()) return;
    await updateRepertoire(id, { name: name.trim() });
    await reloadRepertoires();
    onDataChange();
  }

  async function handleReorderRepertoires(orderedActiveIds: string[]) {
    const activeById = new Map(repertoires.filter(rep => !rep.archived).map(rep => [rep.id, rep]));
    const seen = new Set<string>();
    const orderedActive: Repertoire[] = [];
    for (const id of orderedActiveIds) {
      const rep = activeById.get(id);
      if (rep && !seen.has(id)) {
        orderedActive.push(rep);
        seen.add(id);
      }
    }
    for (const rep of repertoires) {
      if (!rep.archived && !seen.has(rep.id)) orderedActive.push(rep);
    }
    const archived = repertoires.filter(rep => rep.archived);
    const next = [...orderedActive, ...archived];
    setRepertoires(next);
    await setMeta(META_REPERTOIRE_ORDER, orderedActive.map(rep => rep.id));
    scheduleAccountSync();
  }

  async function handleFirstRunSkip() {
    await completeFirstRunOnboarding();
    setShowFirstRunOnboarding(false);
    setOnboardingDraft({ step: 'welcome', color: null, openingKey: null, sourcePreset: 'default' });
    onDataChange();
  }

  async function handleOnboardingStartMapping() {
    const opening = CURATED_OPENINGS.find(item => item.key === onboardingDraft.openingKey);
    if (!opening) throw new Error('Choose an opening first.');
    const target = await getOnboardingTargetRepertoire(opening.color);
    const rep = await getRepertoire(target.id);
    if (!rep) throw new Error('Could not find the selected repertoire.');
    const prepared = prepareOpeningLineForRepertoire(rep, opening, opening.moves);
    if (prepared.moves.length > 0) {
      await addMovesToRepertoire(rep, prepared.moves, { scaffoldPlyCount: prepared.scaffoldPlyCount });
    }
    await markCuratedOpeningScaffolds(rep);
    await applyOnboardingSourcePreset(
      { kind: 'opening-folder', repertoireId: rep.id, openingKey: opening.key },
      onboardingDraft.sourcePreset
    );
    await reloadRepertoires();
    setActiveRepId(rep.id);
    setActiveOpeningKey(opening.key);
    setPrepMapRequest({ repId: rep.id, openingKey: opening.key, nonce: Date.now() });
    setOnboardingDraft(current => ({ ...current, step: 'mapping', color: opening.color, openingKey: opening.key }));
    setShowFirstRunOnboarding(false);
    setTab('train');
    onDataChange();
  }

  async function getOnboardingTargetRepertoire(color: Color): Promise<Repertoire> {
    let list = repertoires.length > 0 ? repertoires : await reloadRepertoires();
    if (list.length === 0) list = await ensureDefaultMainRepertoires();
    const expectedName = color === 'w' ? 'White Main Repertoire' : 'Black Main Repertoire';
    const exact = list.find(rep => rep.color === color && rep.name === expectedName);
    return exact ?? list.find(rep => rep.color === color && (rep.projectKind ?? 'standard') !== 'siloed') ?? list.find(rep => rep.color === color) ?? list[0];
  }

  function handleOnboardingPrepMapFinished() {
    if (onboardingDraft.step !== 'mapping') return;
    setOnboardingDraft(current => ({ ...current, step: 'finish' }));
    setShowFirstRunOnboarding(true);
  }

  async function handleOnboardingStartTraining() {
    if (!activeRepId) return;
    await completeFirstRunOnboarding();
    setShowFirstRunOnboarding(false);
    setTrainingStartRequest({ repId: activeRepId, openingKey: onboardingDraft.openingKey, nonce: Date.now() });
    setActiveOpeningKey(onboardingDraft.openingKey);
    setTab('train');
    onDataChange();
  }

  async function handleOnboardingGoRepertoires() {
    await completeFirstRunOnboarding();
    setShowFirstRunOnboarding(false);
    setTab('repertoires');
    onDataChange();
  }

  async function handleExport() {
    const data = await exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `chesski-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function handleImportClick() { fileInputRef.current?.click(); }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text) as ExportData;
      if (data.version !== 2) throw new Error('Not a v2 export.');
      const mode = window.confirm('Replace your current data with this file?\n\nOK = replace, Cancel = merge in.') ? 'replace' : 'merge';
      await importAll(data, mode);
      await reloadRepertoires();
      onDataChange();
      alert(`Import complete: ${data.repertoires.length} repertoires, ${data.nodes.length} nodes, ${data.edges.length} edges (${mode}).`);
    } catch (err) {
      alert('Import failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      e.target.value = '';
    }
  }

  // Don't render anything until we've checked for the token.
  if (!tokenChecked) return null;

  // Forced token modal: must save before app loads.
  if (!hasToken) {
    return <TokenModal onSaved={() => setHasToken(true)} />;
  }

  if (repertoires.length === 0) {
    return (
      <div className="app">
        <h2 style={{ marginTop: 0 }}>Chesski</h2>
        <NewOpeningMode
          repertoires={repertoires}
          activeRepId={activeRepId}
          onCreated={handleCreated}
          onChanged={async () => { await reloadRepertoires(); onDataChange(); }}
          onOpen={handleOpenRepertoire}
          startOnly
        />
        <details className="collapsible">
          <summary>Custom repertoire tools</summary>
          <div className="panel">
            <NewRepertoireCreator repertoires={repertoires} onCreated={handleCreated} />
          </div>
        </details>
        <div className="panel">
          <h3>Import an existing backup</h3>
          <div className="row">
            <button onClick={handleImportClick}>Import JSON...</button>
            <input type="file" accept="application/json" ref={fileInputRef} onChange={handleImportFile} style={{ display: 'none' }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className={'tabs' + (trainingSessionActive && tab === 'train' ? ' session-locked' : '')}>
        <button className={'tab' + (tab === 'repertoires' ? ' active' : '')} onClick={() => setTab('repertoires')}>
          Repertoires
          <span className={'badge' + (dueCount === 0 ? ' zero' : '')}>{dueCount}</span>
        </button>
        <button className={'tab' + (tab === 'games' ? ' active' : '')} onClick={() => setTab('games')}>
          Games
        </button>
        <button className={'tab' + (tab === 'settings' ? ' active' : '')} onClick={() => setTab('settings')}>
          Settings
        </button>
        <button className={'tab' + (tab === 'account' ? ' active' : '')} onClick={() => setTab('account')}>
          Account
        </button>
      </div>

      {showFirstRunOnboarding && (
        <FirstRunOnboarding
          draft={onboardingDraft}
          repertoires={repertoires}
          onDraftChange={setOnboardingDraft}
          onStartMapping={handleOnboardingStartMapping}
          onStartTraining={handleOnboardingStartTraining}
          onGoRepertoires={handleOnboardingGoRepertoires}
          onSkip={handleFirstRunSkip}
        />
      )}

      {onboardingDraft.step === 'mapping' && tab === 'train' && (
        <div className="onboarding-inline-note">
          <span>Map what you already know, then stop mapping when you are ready for your first training session.</span>
        </div>
      )}

      {starterNotice && tab === 'repertoires' && (
        <div className="onboarding-inline-note">
          <span>OK, we're going to start with teaching you one white opening first.</span>
          <button onClick={() => setStarterNotice(false)}>Dismiss</button>
        </div>
      )}

      {importNotice && tab === 'games' && (
        <div className="onboarding-inline-note">
          <span>Start by importing games for one color. After Chesski finds the frontiers of your prep, tune the player sources in Algorithm.</span>
          <button onClick={() => setImportNotice(false)}>Dismiss</button>
        </div>
      )}

      {activeRep ? (
        <>
          {tab === 'home' && (
            <HomeMode
              repertoires={repertoires}
              activeRepId={activeRepId}
              activeOpeningKey={activeOpeningKey}
              refreshKey={refreshKey}
              onChoose={handleChooseRepertoire}
              onDeleteOpeningPrep={handleDeleteOpeningPrep}
              onNewOpening={handleAddOpening}
              onOpenRepertoireAlgorithm={handleOpenRepertoireAlgorithm}
              onOpenOpeningAlgorithm={handleOpenOpeningAlgorithm}
              onDeleteRep={handleDeleteRepertoire}
              onArchiveRep={handleArchiveRepertoire}
              onUnarchiveRep={handleUnarchiveRepertoire}
              onRenameRep={handleRenameRepertoire}
              onReorderRepertoires={handleReorderRepertoires}
            />
          )}
          {tab === 'train' && (
            <ViewErrorBoundary resetKey={`train:${activeRep.id}:${activeOpeningKey ?? 'all'}:${refreshKey}`} onBack={() => setTab('repertoires')}>
              <TrainMode repertoire={activeRep} openingKey={activeOpeningKey} onOpeningChange={setActiveOpeningKey} onDataChange={onDataChange} refreshKey={refreshKey} boardSize={boardSize} onBoardSizeChange={setBoardSize} onSessionActiveChange={setTrainingSessionActive} onBack={() => setTab('repertoires')} prepMapRequest={prepMapRequest?.repId === activeRep.id ? prepMapRequest : null} trainingStartRequest={trainingStartRequest?.repId === activeRep.id ? trainingStartRequest : null} onPrepMapFinished={handleOnboardingPrepMapFinished} />
            </ViewErrorBoundary>
          )}
          {tab === 'browse' && (
            <ViewErrorBoundary resetKey={`browse:${activeRep.id}:${activeOpeningKey ?? 'all'}:${refreshKey}`} onBack={() => setTab('repertoires')}>
              <BrowseMode repertoire={activeRep} openingKey={activeOpeningKey} onOpeningChange={setActiveOpeningKey} onDataChange={onDataChange} refreshKey={refreshKey} boardSize={boardSize} onBoardSizeChange={setBoardSize} onBack={() => setTab('repertoires')} />
            </ViewErrorBoundary>
          )}
          {tab === 'games' && (
            <GamesMode
              repertoire={activeRep}
              onDataChange={onDataChange}
              repertoires={repertoires}
              activeRepId={activeRepId}
              onChanged={async () => { await reloadRepertoires(); onDataChange(); }}
              onOpen={handleOpenRepertoire}
            />
          )}
          {tab === 'new-opening' && (
            <NewOpeningMode
              repertoires={repertoires}
              activeRepId={activeRepId}
              onCreated={handleCreated}
              onChanged={async () => { await reloadRepertoires(); onDataChange(); }}
              onOpen={handleOpenRepertoire}
              scopedRepertoireId={activeRepId}
              onBack={() => setTab('repertoires')}
              onStartPrepMap={handleStartOpeningPrepMap}
            />
          )}
          {tab === 'repertoires' && (
            <>
              <HomeMode
                repertoires={repertoires}
                activeRepId={activeRepId}
                activeOpeningKey={activeOpeningKey}
                refreshKey={refreshKey}
                onChoose={handleChooseRepertoire}
                onDeleteOpeningPrep={handleDeleteOpeningPrep}
                onNewOpening={handleAddOpening}
                onOpenRepertoireAlgorithm={handleOpenRepertoireAlgorithm}
                onOpenOpeningAlgorithm={handleOpenOpeningAlgorithm}
                onDeleteRep={handleDeleteRepertoire}
                onArchiveRep={handleArchiveRepertoire}
                onUnarchiveRep={handleUnarchiveRepertoire}
                onRenameRep={handleRenameRepertoire}
                onReorderRepertoires={handleReorderRepertoires}
              />
              <details className="collapsible custom-tools-panel">
                <summary>Custom / import tools</summary>
                <div className="panel">
                  <NewRepertoireCreator repertoires={repertoires} onCreated={handleCreated} />
                </div>
              </details>
            </>
          )}
          {tab === 'settings' && <SettingsMode onTriviaProgressChange={onDataChange} onOpenGlobalAlgorithm={handleOpenGlobalAlgorithm} onRestartOnboarding={handleRestartOnboarding} />}
          {tab === 'account' && (
            <AccountMode
              onRestored={onAccountRestored}
              onTokenChanged={onAccountRestored}
              onBackup={handleExport}
              onRestore={handleImportClick}
              onRestartOnboarding={handleRestartOnboarding}
              restoreInput={<input type="file" accept="application/json" ref={fileInputRef} onChange={handleImportFile} style={{ display: 'none' }} />}
            />
          )}
          {tab === 'algorithm' && algorithmTarget && (
            <AlgorithmMode
              scope={algorithmTarget.scope}
              title={algorithmTarget.title}
              parentTitle={algorithmTarget.parentTitle}
              repertoires={repertoires}
              onBack={() => setTab(algorithmTarget.scope.kind === 'global' ? 'settings' : 'repertoires')}
            />
          )}
        </>
      ) : (
        <div className="panel">Select a repertoire above.</div>
      )}
    </div>
  );
}

function GamesMode({ repertoire, onDataChange, repertoires, activeRepId, onChanged, onOpen }: {
  repertoire: Repertoire;
  onDataChange: () => void;
  repertoires: Repertoire[];
  activeRepId: string | null;
  onChanged: () => void | Promise<void>;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="games-mode">
      <div className="games-section-heading">
        <h2>Games</h2>
        <div className="muted small">Analyze a game, import games, or build repertoire drafts from your own play.</div>
      </div>
      <section className="games-section">
        <h3>Analyze a game</h3>
        <ReviewMode repertoire={repertoire} onDataChange={onDataChange} />
      </section>
      <section className="games-section">
        <h3>Import games / build from my games</h3>
        <GameImportMode
          repertoires={repertoires}
          activeRepId={activeRepId}
          onChanged={onChanged}
          onOpen={onOpen}
        />
      </section>
    </div>
  );
}

function FirstRunOnboarding({ draft, repertoires, onDraftChange, onStartMapping, onStartTraining, onGoRepertoires, onSkip }: {
  draft: OnboardingDraft;
  repertoires: Repertoire[];
  onDraftChange: Dispatch<SetStateAction<OnboardingDraft>>;
  onStartMapping: () => Promise<void>;
  onStartTraining: () => Promise<void>;
  onGoRepertoires: () => Promise<void>;
  onSkip: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedOpening = CURATED_OPENINGS.find(opening => opening.key === draft.openingKey) ?? null;
  const selectedRep = draft.color
    ? repertoires.find(rep => rep.color === draft.color && rep.name === (draft.color === 'w' ? 'White Main Repertoire' : 'Black Main Repertoire'))
      ?? repertoires.find(rep => rep.color === draft.color)
      ?? null
    : null;

  async function run(kind: string, action: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function goBack() {
    onDraftChange(current => {
      if (current.step === 'source') return { ...current, step: 'opening' };
      if (current.step === 'opening') return { ...current, step: 'side' };
      if (current.step === 'side') return { ...current, step: 'welcome' };
      return current;
    });
  }

  return (
    <div className="modal-backdrop soft">
      <div className="modal onboarding-modal onboarding-wizard">
        {draft.step !== 'welcome' && draft.step !== 'finish' && (
          <div className="subview-back-row onboarding-back-row">
            <button onClick={goBack} disabled={!!busy}>Back</button>
          </div>
        )}

        {draft.step === 'welcome' && (
          <>
            <div className="onboarding-mascot-row">
              <img src="/chesski-256.png" alt="" className="onboarding-mascot" />
              <div>
                <h2>Welcome to Chesski</h2>
                <p className="muted">
                  Chesski organizes your prep like this: Repertoire {'->'} Opening {'->'} Lines.
                </p>
              </div>
            </div>
            <div className="onboarding-model-examples">
              <div><strong>White Main Repertoire</strong><span>{'->'} Italian Game {'->'} lines you train</span></div>
              <div><strong>Black Main Repertoire</strong><span>{'->'} Caro-Kann Defense {'->'} lines you train</span></div>
            </div>
            <div className="row onboarding-actions">
              <button className="primary" onClick={() => onDraftChange(current => ({ ...current, step: 'side' }))}>Get started</button>
              <button onClick={() => void run('skip', onSkip)} disabled={!!busy}>Skip</button>
            </div>
          </>
        )}

        {draft.step === 'side' && (
          <>
            <h2>What do you want to study first?</h2>
            <p className="muted">Chesski already created a main repertoire for both sides.</p>
            <div className="onboarding-choice-grid two">
              {(['w', 'b'] as Color[]).map(color => (
                <button
                  key={color}
                  className={draft.color === color ? 'selected-choice' : ''}
                  onClick={() => onDraftChange(current => ({ ...current, color, openingKey: null, step: 'opening' }))}
                >
                  <strong>{color === 'w' ? 'White Main Repertoire' : 'Black Main Repertoire'}</strong>
                </button>
              ))}
            </div>
            <div className="row onboarding-actions">
              <button onClick={() => void run('skip', onSkip)} disabled={!!busy}>Skip onboarding</button>
            </div>
          </>
        )}

        {draft.step === 'opening' && draft.color && (
          <>
            <h2>Add your first opening</h2>
            <p className="muted">
              Choose an opening for {selectedRep?.name ?? (draft.color === 'w' ? 'White Main Repertoire' : 'Black Main Repertoire')}.
            </p>
            <div className="onboarding-opening-grid">
              {CURATED_OPENINGS.filter(opening => opening.color === draft.color).map(opening => (
                <button
                  key={opening.key}
                  className={'opening-card onboarding-opening-card' + (opening.key === draft.openingKey ? ' selected' : '')}
                  onClick={() => onDraftChange(current => ({ ...current, openingKey: opening.key, step: 'source' }))}
                >
                  <div className="opening-card-copy">
                    <strong>{opening.name}</strong>
                    <span>{opening.moves.join(' ')}</span>
                  </div>
                </button>
              ))}
            </div>
            <div className="row onboarding-actions">
              <button onClick={() => void run('skip', onSkip)} disabled={!!busy}>Skip onboarding</button>
            </div>
          </>
        )}

        {draft.step === 'source' && selectedOpening && (
          <>
            <h2>Whose games should Chesski learn from?</h2>
            <p className="muted">You can change this later from the Algorithm button for {selectedOpening.name}.</p>
            <div className="onboarding-preset-grid">
              {ONBOARDING_SOURCE_PRESETS.map(preset => (
                <button
                  key={preset.key}
                  className={draft.sourcePreset === preset.key ? 'selected-choice' : ''}
                  onClick={() => onDraftChange(current => ({ ...current, sourcePreset: preset.key }))}
                >
                  <strong>{preset.name}</strong>
                  <span>{preset.description}</span>
                </button>
              ))}
            </div>
            <div className="row onboarding-actions">
              <button className="primary" onClick={() => void run('mapping', onStartMapping)} disabled={!!busy}>
                {busy === 'mapping' ? 'Opening board...' : 'Continue to board'}
              </button>
              <button onClick={() => void run('skip', onSkip)} disabled={!!busy}>Skip onboarding</button>
            </div>
          </>
        )}

        {draft.step === 'finish' && selectedOpening && (
          <>
            <h2>Your first opening is ready</h2>
            <p className="muted">
              {selectedRep?.name ?? 'Your repertoire'} / {selectedOpening.name} is set up. Start with this opening folder, or head back to the hub.
            </p>
            <div className="onboarding-choice-grid two">
              <button className="primary" onClick={() => void run('train', onStartTraining)} disabled={!!busy}>
                {busy === 'train' ? 'Starting...' : 'Start training now'}
              </button>
              <button onClick={() => void run('hub', onGoRepertoires)} disabled={!!busy}>
                Go to Repertoires
              </button>
            </div>
          </>
        )}

        {error && <div className="account-status bad small">{error}</div>}
      </div>
    </div>
  );
}

interface HomeRepStats {
  totalMoves: number;
  userMoves: number;
  dueMoves: number;
  learnedMoves: number;
  openingFolders: Array<OpeningFolder & { lineCount: number }>;
}

function HomeMode({ repertoires, activeRepId, activeOpeningKey, refreshKey, onChoose, onDeleteOpeningPrep, onNewOpening, onOpenRepertoireAlgorithm, onOpenOpeningAlgorithm, onDeleteRep, onArchiveRep, onUnarchiveRep, onRenameRep, onReorderRepertoires }: {
  repertoires: Repertoire[];
  activeRepId: string | null;
  activeOpeningKey: string | null;
  refreshKey: number;
  onChoose: (id: string, nextTab?: Tab, openingKey?: string | null) => void;
  onDeleteOpeningPrep: (repId: string, folder: OpeningFolder) => void | Promise<void>;
  onNewOpening: (repId: string) => void;
  onOpenRepertoireAlgorithm: (rep: Repertoire) => void;
  onOpenOpeningAlgorithm: (rep: Repertoire, folder: OpeningFolder) => void;
  onDeleteRep: (id: string) => void;
  onArchiveRep: (id: string) => void;
  onUnarchiveRep: (id: string) => void;
  onRenameRep: (id: string, name: string) => void;
  onReorderRepertoires: (orderedActiveIds: string[]) => void | Promise<void>;
}) {
  const [statsByRep, setStatsByRep] = useState<Record<string, HomeRepStats>>({});
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const activeReps = repertoires.filter(rep => !rep.archived);
  const archivedReps = repertoires.filter(rep => rep.archived);
  const activeRep = activeReps.find(rep => rep.id === activeRepId) ?? activeReps[0] ?? null;
  const activeStats = activeRep ? statsByRep[activeRep.id] : undefined;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const now = new Date();
      const entries = await Promise.all(repertoires.map(async rep => {
        const edges = await getEdgesForRepertoire(rep.id);
        const userEdges = edges.filter(edge => edge.mover === rep.color);
        const openingFolders = listOpeningFoldersForRepertoire(rep, edges)
          .map(folder => ({ ...folder, lineCount: countOpeningLines(folder, edges) }));
        const stats: HomeRepStats = {
          totalMoves: edges.length,
          userMoves: userEdges.length,
          dueMoves: userEdges.filter(edge => isDue(edge, now)).length,
          learnedMoves: userEdges.filter(edge => edge.reps > 0).length,
          openingFolders,
        };
        return [rep.id, stats] as const;
      }));
      if (!cancelled) setStatsByRep(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [repertoires, refreshKey]);

  if (!activeRep) return <div className="panel empty-state">Add your first opening.</div>;

  return (
    <div className="home-layout">
      <div className="page-header home-page-header">
        <div>
          <div className="eyebrow">Opening laboratory</div>
          <h1>Repertoires</h1>
          <p>Build weapons from the games of the greats. Know where your prep ends.</p>
        </div>
      </div>
      <div className="panel home-current">
        <div>
          <h3>Main workspace</h3>
          <div className="home-current-title-row">
            {editingName ? (
              <input
                className="home-rep-rename-input"
                value={draftName}
                autoFocus
                onChange={e => setDraftName(e.target.value)}
                onBlur={() => { onRenameRep(activeRep.id, draftName); setEditingName(false); }}
                onKeyDown={e => {
                  if (e.key === 'Enter') { onRenameRep(activeRep.id, draftName); setEditingName(false); }
                  if (e.key === 'Escape') setEditingName(false);
                }}
              />
            ) : (
              <>
                <span className="home-current-title">{activeRep.name}</span>
                <button className="rep-rename-btn" title="Rename" onClick={() => { setDraftName(activeRep.name); setEditingName(true); }}>✎</button>
              </>
            )}
          </div>
          <div className="muted small">
            {openingLabel(activeRep)} - {activeRep.color === 'w' ? 'White' : 'Black'} - {repKindLabel(activeRep)}
          </div>
          <div className="home-stat-grid">
            <StatBlock value={activeStats?.dueMoves ?? 0} label="due" />
            <StatBlock value={activeStats?.learnedMoves ?? 0} label="learned" />
            <StatBlock value={activeStats?.userMoves ?? 0} label="cards" />
            <StatBlock value={activeStats?.totalMoves ?? 0} label="moves" />
          </div>
          <div className="row home-actions">
            <button className="primary" onClick={() => onChoose(activeRep.id, 'train')}>Train</button>
            <button onClick={() => onChoose(activeRep.id, 'browse')}>View lines</button>
            <button onClick={() => onOpenRepertoireAlgorithm(activeRep)}>Algorithm</button>
            <button onClick={() => onNewOpening(activeRep.id)}>Add opening</button>
            <button onClick={() => onChoose(activeRep.id, 'games')}>Analyze My Game</button>
          </div>
          <div className="row home-actions-secondary">
            <button onClick={() => onArchiveRep(activeRep.id)}>Archive</button>
            <button className="danger" onClick={() => onDeleteRep(activeRep.id)}>Delete repertoire</button>
          </div>
          <OpeningFolderList
            rep={activeRep}
            folders={activeStats?.openingFolders ?? []}
            activeOpeningKey={activeOpeningKey}
            onChoose={onChoose}
            onDelete={onDeleteOpeningPrep}
            onNewOpening={onNewOpening}
            onAlgorithm={folder => onOpenOpeningAlgorithm(activeRep, folder)}
          />
        </div>
        <div className="home-board-preview" style={{ pointerEvents: 'none' }}>
          <Board
            fen={activeRep.rootFen}
            orientation={activeRep.color === 'w' ? 'white' : 'black'}
            onMove={() => false}
            allowMoves={false}
            size={180}
            showNotation={false}
          />
        </div>
      </div>

      <div className="home-picker">
        <HomeRepertoireGroup
          title="Repertoires"
          repertoires={activeReps}
          activeRepId={activeRep.id}
          activeOpeningKey={activeOpeningKey}
          statsByRep={statsByRep}
          onChoose={onChoose}
          onDeleteOpeningPrep={onDeleteOpeningPrep}
          onNewOpening={onNewOpening}
          onOpenRepertoireAlgorithm={onOpenRepertoireAlgorithm}
          onOpenOpeningAlgorithm={onOpenOpeningAlgorithm}
          onReorder={onReorderRepertoires}
        />
        {archivedReps.length > 0 && (
          <details className="collapsible home-archived-section">
            <summary>Archived ({archivedReps.length})</summary>
            <div className="home-rep-grid home-archived-grid">
              {archivedReps.map(rep => (
                <div key={rep.id} className="home-rep-card home-rep-card-archived">
                  <div className="home-rep-main">
                    <span className="side-pill">{rep.color === 'w' ? 'White' : 'Black'}</span>
                    <div className="home-rep-title">{rep.name}</div>
                  </div>
                  <div className="row home-rep-actions">
                    <button onClick={e => { e.stopPropagation(); onUnarchiveRep(rep.id); }}>Unarchive</button>
                    <button className="danger" onClick={e => { e.stopPropagation(); onDeleteRep(rep.id); }}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function HomeRepertoireGroup({ title, repertoires, activeRepId, activeOpeningKey, statsByRep, onChoose, onDeleteOpeningPrep, onNewOpening, onOpenRepertoireAlgorithm, onOpenOpeningAlgorithm, onReorder }: {
  title: string;
  repertoires: Repertoire[];
  activeRepId: string;
  activeOpeningKey: string | null;
  statsByRep: Record<string, HomeRepStats>;
  onChoose: (id: string, nextTab?: Tab, openingKey?: string | null) => void;
  onDeleteOpeningPrep: (repId: string, folder: OpeningFolder) => void | Promise<void>;
  onNewOpening: (repId: string) => void;
  onOpenRepertoireAlgorithm: (rep: Repertoire) => void;
  onOpenOpeningAlgorithm: (rep: Repertoire, folder: OpeningFolder) => void;
  onReorder: (orderedActiveIds: string[]) => void | Promise<void>;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);

  function moveRepertoire(dragId: string, targetId: string) {
    if (dragId === targetId) return;
    const ids = repertoires.map(rep => rep.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    void onReorder(ids);
  }

  return (
    <div className="panel">
      <h3>{title}</h3>
      {repertoires.length === 0 ? (
        <div className="settings-empty-drop empty-state">Add your first opening.</div>
      ) : (
        <div className="home-rep-grid">
          {repertoires.map(rep => (
            <div
              key={rep.id}
              draggable
              className={'home-rep-drag-shell' + (draggingId === rep.id ? ' dragging' : '')}
              onDragStart={e => {
                setDraggingId(rep.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', rep.id);
              }}
              onDragOver={e => {
                if (!draggingId || draggingId === rep.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={e => {
                e.preventDefault();
                const dragId = e.dataTransfer.getData('text/plain') || draggingId;
                if (dragId) moveRepertoire(dragId, rep.id);
                setDraggingId(null);
              }}
              onDragEnd={() => setDraggingId(null)}
            >
              <HomeRepertoireCard
                rep={rep}
                active={rep.id === activeRepId}
                activeOpeningKey={rep.id === activeRepId ? activeOpeningKey : null}
                stats={statsByRep[rep.id]}
                onChoose={onChoose}
                onDeleteOpeningPrep={onDeleteOpeningPrep}
                onNewOpening={onNewOpening}
                onOpenRepertoireAlgorithm={onOpenRepertoireAlgorithm}
                onOpenOpeningAlgorithm={onOpenOpeningAlgorithm}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HomeRepertoireCard({ rep, active, activeOpeningKey, stats, onChoose, onDeleteOpeningPrep, onNewOpening, onOpenRepertoireAlgorithm, onOpenOpeningAlgorithm }: {
  rep: Repertoire;
  active: boolean;
  activeOpeningKey: string | null;
  stats?: HomeRepStats;
  onChoose: (id: string, nextTab?: Tab, openingKey?: string | null) => void;
  onDeleteOpeningPrep: (repId: string, folder: OpeningFolder) => void | Promise<void>;
  onNewOpening: (repId: string) => void;
  onOpenRepertoireAlgorithm: (rep: Repertoire) => void;
  onOpenOpeningAlgorithm: (rep: Repertoire, folder: OpeningFolder) => void;
}) {
  return (
    <div className={'home-rep-card' + (active ? ' active' : '')} onClick={() => onChoose(rep.id)} style={{ cursor: 'pointer' }}>
      <div className="home-rep-main">
        <span className="side-pill">{rep.color === 'w' ? 'White' : 'Black'}</span>
        <div className="home-rep-title">{rep.name}</div>
        <div className="muted small">{openingLabel(rep)}</div>
      </div>
      <div className="home-mini-stats">
        <span><strong>{stats?.dueMoves ?? 0}</strong> due</span>
        <span><strong>{stats?.learnedMoves ?? 0}</strong> / {stats?.userMoves ?? 0} learned</span>
      </div>
      <div className="row home-rep-actions">
        <button className="primary" onClick={e => { e.stopPropagation(); onChoose(rep.id, 'train'); }}>Train</button>
        <button onClick={e => { e.stopPropagation(); onChoose(rep.id, 'browse'); }}>View lines</button>
        <button onClick={e => { e.stopPropagation(); onOpenRepertoireAlgorithm(rep); }}>Algorithm</button>
        <button onClick={e => { e.stopPropagation(); onNewOpening(rep.id); }}>Add opening</button>
      </div>
      <OpeningFolderList
        rep={rep}
        folders={stats?.openingFolders ?? []}
        activeOpeningKey={activeOpeningKey}
        onChoose={onChoose}
        onDelete={onDeleteOpeningPrep}
        onNewOpening={onNewOpening}
        onAlgorithm={folder => onOpenOpeningAlgorithm(rep, folder)}
        compact
      />
    </div>
  );
}

function OpeningFolderList({ rep, folders, activeOpeningKey, onChoose, onDelete, onNewOpening, onAlgorithm, compact }: {
  rep: Repertoire;
  folders: Array<OpeningFolder & { lineCount: number }>;
  activeOpeningKey: string | null;
  onChoose: (id: string, nextTab?: Tab, openingKey?: string | null) => void;
  onDelete: (repId: string, folder: OpeningFolder) => void | Promise<void>;
  onNewOpening: (repId: string) => void;
  onAlgorithm: (folder: OpeningFolder) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(!compact);

  if (folders.length === 0) {
    return (
      <div className={compact ? 'opening-empty-cta compact empty-state' : 'opening-empty-cta empty-state'}>
        <span>No openings yet. Add your first opening.</span>
        <button onClick={e => { e.stopPropagation(); onNewOpening(rep.id); }}>Add opening</button>
      </div>
    );
  }
  const lineCount = folders.reduce((sum, folder) => sum + folder.lineCount, 0);

  return (
    <div className={compact ? 'opening-folder-list compact' : 'opening-folder-list'} style={{ marginTop: compact ? 8 : 12 }}>
      <button
        type="button"
        className="opening-folder-summary"
        aria-expanded={open}
        onClick={e => {
          e.stopPropagation();
          setOpen(value => !value);
        }}
      >
        <span className="folder-toggle muted small">{open ? 'v' : '>'}</span>
        <span className="opening-folder-summary-title">Openings</span>
        <span className="muted small">{folders.length} folder{folders.length === 1 ? '' : 's'} · {lineCount} line{lineCount === 1 ? '' : 's'}</span>
      </button>
      {open && (
        <div className="opening-folder-contents">
          {folders.map(folder => (
            <span key={folder.key} className="opening-folder-chip">
              <span className="opening-folder-copy">
                <span className="opening-folder-name">{folder.name}</span>
                <span className="muted small">{folder.lineCount} line{folder.lineCount === 1 ? '' : 's'}</span>
              </span>
              <button
                className={folder.key === activeOpeningKey ? 'active' : ''}
                onClick={e => {
                  e.stopPropagation();
                  onChoose(rep.id, 'train', folder.key);
                }}
                title={`Train ${folder.name}`}
              >
                Train
              </button>
              <button
                onClick={e => {
                  e.stopPropagation();
                  onChoose(rep.id, 'browse', folder.key);
                }}
                title={`View ${folder.name} lines`}
              >
                View lines
              </button>
              <button
                onClick={e => {
                  e.stopPropagation();
                  onAlgorithm(folder);
                }}
              >
                Algorithm
              </button>
              <button
                className="danger"
                onClick={e => {
                  e.stopPropagation();
                  void onDelete(rep.id, folder);
                }}
                title={`Delete ${folder.name} prep`}
              >
                Delete
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StatBlock({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <strong>{value}</strong>
      <span className="muted small">{label}</span>
    </div>
  );
}

function openingLabel(rep: Repertoire): string {
  const opening = rep.openingKey ? CURATED_OPENINGS.find(item => item.key === rep.openingKey) : null;
  return opening?.name ?? 'Preparation tree';
}

function repKindLabel(rep: Repertoire): string {
  return (rep.projectKind ?? 'standard') === 'siloed' ? 'separate repertoire' : 'standard repertoire';
}

function countOpeningLines(folder: OpeningFolder, edges: Edge[]): number {
  const byParent = new Map<string, Edge[]>();
  for (const edge of edges) {
    const current = byParent.get(edge.parentFen) ?? [];
    current.push(edge);
    byParent.set(edge.parentFen, current);
  }

  let count = 0;
  const stack = [folder.baseFen];
  const visited = new Set<string>();
  while (stack.length) {
    const fen = stack.pop()!;
    if (visited.has(fen)) continue;
    visited.add(fen);
    const children = byParent.get(fen) ?? [];
    if (children.length === 0) {
      count++;
      continue;
    }
    for (const child of children) stack.push(child.childFen);
  }
  return count;
}

function NewRepertoireCreator({ repertoires, onCreated, compact }: {
  repertoires: Repertoire[];
  onCreated: (rep: Repertoire) => void | Promise<void>;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<'template' | 'empty' | 'fen' | 'pgn' | 'clone'>('template');
  const [name, setName] = useState('');
  const [color, setColor] = useState<Color>('w');
  const [templateKey, setTemplateKey] = useState(CURATED_OPENINGS[0]?.key ?? '');
  const [fen, setFen] = useState('');
  const [pgn, setPgn] = useState('');
  const [cloneId, setCloneId] = useState(repertoires[0]?.id ?? '');
  const [projectKind, setProjectKind] = useState<Repertoire['projectKind']>('standard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      let rep: Repertoire;
      if (mode === 'template') {
        const template = CURATED_OPENINGS.find(opening => opening.key === templateKey);
        if (!template) throw new Error('Pick a template.');
        rep = await createRepertoire({
          name: name.trim() || template.name,
          color: template.color,
          openingKey: template.key,
          moves: template.moves,
          scaffoldPlyCount: template.moves.length,
          projectKind,
        });
      } else if (mode === 'empty') {
        rep = await createRepertoire({ name: name.trim() || 'New repertoire', color, projectKind });
      } else if (mode === 'fen') {
        rep = await createRepertoireFromFen(name.trim() || 'Position repertoire', color, fen, projectKind);
      } else if (mode === 'pgn') {
        rep = await createRepertoireFromPgn(name.trim() || 'PGN repertoire', color, pgn, undefined, projectKind);
      } else {
        rep = await cloneRepertoire(cloneId, name.trim() || undefined);
      }
      await onCreated(rep);
      setName('');
      setFen('');
      setPgn('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? 'new-rep compact' : 'new-rep'}>
      <div className="row">
        <select value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
          <option value="template">From opening starter</option>
          <option value="empty">Empty</option>
          <option value="fen">From FEN</option>
          <option value="pgn">From PGN</option>
          <option value="clone" disabled={repertoires.length === 0}>Clone existing</option>
        </select>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Repertoire name" />
      </div>

      {mode === 'template' && (
        <div className="new-rep-grid">
          {CURATED_OPENINGS.map(opening => (
            <button
              key={opening.key}
              className={opening.key === templateKey ? 'selected-choice' : ''}
              onClick={() => setTemplateKey(opening.key)}
            >
              {opening.name} <span className="muted small">{opening.color === 'w' ? 'White' : 'Black'}</span>
            </button>
          ))}
        </div>
      )}

      {mode !== 'template' && mode !== 'clone' && (
        <div className="row">
          <label className="small muted">Color</label>
          <select value={color} onChange={e => setColor(e.target.value as Color)}>
            <option value="w">White</option>
            <option value="b">Black</option>
          </select>
        </div>
      )}

      {mode === 'fen' && (
        <input className="new-rep-wide" value={fen} onChange={e => setFen(e.target.value)} placeholder="Paste FEN" />
      )}

      {mode === 'pgn' && (
        <textarea className="new-rep-pgn" value={pgn} onChange={e => setPgn(e.target.value)} placeholder="Paste PGN" />
      )}

      {mode === 'clone' && (
        <select value={cloneId} onChange={e => setCloneId(e.target.value)}>
          {repertoires.map(rep => (
            <option key={rep.id} value={rep.id}>{rep.name} ({rep.color === 'w' ? 'White' : 'Black'})</option>
          ))}
        </select>
      )}

      <label className="row new-rep-check">
        <input
          type="checkbox"
          checked={projectKind === 'siloed'}
          onChange={e => setProjectKind(e.target.checked ? 'siloed' : 'standard')}
        />
        <span>
          Separate repertoire
          <span className="muted small"> can contradict another repertoire</span>
        </span>
      </label>

      <div className="row">
        <button className="primary" onClick={create} disabled={busy || (mode === 'fen' && !fen.trim()) || (mode === 'pgn' && !pgn.trim())}>
          {busy ? 'Creating...' : 'Create repertoire'}
        </button>
      </div>
      {error && <div className="small account-status bad">{error}</div>}
    </div>
  );
}

class ViewErrorBoundary extends Component<
  { resetKey: string; onBack: () => void; children: ReactNode },
  { error: string | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: unknown) {
    console.error('Chesski view crashed', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="panel view-error-state">
          <h3>This view hit a rendering error.</h3>
          <p className="muted small">The rest of Chesski is still running. Go back and try another opening, or refresh after syncing.</p>
          <div className="mono small view-error-details">{this.state.error}</div>
          <button onClick={this.props.onBack}>Back to repertoires</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default App;

function App() {
  return (
    <BoardPreferencesProvider>
      <TrainingPreferencesProvider>
        <AppContent />
      </TrainingPreferencesProvider>
    </BoardPreferencesProvider>
  );
}
