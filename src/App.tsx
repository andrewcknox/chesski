import { useEffect, useRef, useState, useCallback } from 'react';
import { TrainMode } from './modes/TrainMode';
import { BrowseMode } from './modes/BrowseMode';
import { ReviewMode } from './modes/ReviewMode';
import { RepertoiresMode } from './modes/RepertoiresMode';
import { NewOpeningMode } from './modes/NewOpeningMode';
import { GameImportMode } from './modes/GameImportMode';
import { HistoryMode } from './modes/HistoryMode';
import { AccountMode } from './modes/AccountMode';
import { SettingsMode } from './modes/SettingsMode';
import { Board } from './components/Board';
import { TokenModal } from './components/TokenModal';
import { getCurrentAccount, restoreCurrentAccount, syncCurrentAccount } from './lib/accounts';
import {
  exportAll, importAll, type ExportData,
  listRepertoires, createRepertoire, createRepertoireFromFen,
  createRepertoireFromPgn, cloneRepertoire, deleteRepertoire,
  getEdgesByMover, getEdgesForRepertoire, setMeta, getMeta,
  CURATED_OPENINGS, ensureDefaultMainRepertoires,
} from './lib/storage';
import { getLichessToken } from './lib/lichess';
import { isDue } from './lib/srs';
import { getHistoryDueCount } from './lib/historySrs';
import {
  addStarterOpeningSet,
  completeFirstRunOnboarding,
  getFirstRunOnboardingState,
} from './lib/onboarding';
import type { Color, Repertoire } from './types';

type Tab = 'home' | 'train' | 'browse' | 'review' | 'game-import' | 'new-opening' | 'repertoires' | 'history' | 'settings' | 'account';
const META_LAST_REP = 'last_repertoire_id';
const META_BOARD_SIZE = 'board_size';
const DEFAULT_BOARD_SIZE = 640;

function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [refreshKey, setRefreshKey] = useState(0);
  const [dueCount, setDueCount] = useState(0);
  const [historyDueCount, setHistoryDueCount] = useState(0);
  const [repertoires, setRepertoires] = useState<Repertoire[]>([]);
  const [activeRepId, setActiveRepId] = useState<string | null>(null);
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [showFirstRunOnboarding, setShowFirstRunOnboarding] = useState(false);
  const [starterNotice, setStarterNotice] = useState(false);
  const [importNotice, setImportNotice] = useState(false);
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

  const refreshHistoryDueCount = useCallback(async () => {
    setHistoryDueCount(await getHistoryDueCount());
  }, []);

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
    setRepertoires(list);
    if (list.length === 0) {
      setActiveRepId(null);
      return list;
    }
    if (activeRepId && list.some(r => r.id === activeRepId)) return list;
    const lastId = await getMeta<string>(META_LAST_REP);
    const fallback = lastId && list.some(r => r.id === lastId) ? lastId : list[0].id;
    setActiveRepId(fallback);
    return list;
  }, [activeRepId]);

  useEffect(() => { if (hasToken) void reloadRepertoires(); }, [reloadRepertoires, hasToken]);
  useEffect(() => { void refreshDueCount(); void refreshHistoryDueCount(); }, [refreshDueCount, refreshHistoryDueCount, refreshKey]);

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
    void refreshHistoryDueCount();
    scheduleAccountSync();
  }, [refreshDueCount, refreshHistoryDueCount, scheduleAccountSync]);

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

  function handleOpenRepertoire(id: string) {
    setActiveRepId(id);
    setTab('train');
  }

  function handleChooseRepertoire(id: string, nextTab: Tab = 'home') {
    setActiveRepId(id);
    setTab(nextTab);
  }

  async function handleDelete(id: string) {
    const rep = repertoires.find(r => r.id === id);
    if (!rep) return;
    const ok = window.confirm(`Delete repertoire "${rep.name}" (${rep.color === 'w' ? 'White' : 'Black'})? All its edges and SRS state will be erased.`);
    if (!ok) return;
    await deleteRepertoire(id);
    await reloadRepertoires();
    onDataChange();
  }

  async function handleFirstRunNo() {
    const starter = await addStarterOpeningSet();
    await reloadRepertoires();
    if (starter.activeRepertoireId) setActiveRepId(starter.activeRepertoireId);
    setShowFirstRunOnboarding(false);
    setStarterNotice(true);
    setImportNotice(false);
    setTab('train');
    onDataChange();
  }

  async function handleFirstRunYes() {
    await completeFirstRunOnboarding();
    setShowFirstRunOnboarding(false);
    setStarterNotice(false);
    setImportNotice(true);
    setTab('game-import');
    onDataChange();
  }

  async function handleFirstRunSkip() {
    await completeFirstRunOnboarding();
    setShowFirstRunOnboarding(false);
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
      <div className="tabs">
        <button className={'tab' + (tab === 'home' ? ' active' : '')} onClick={() => setTab('home')}>
          Home
        </button>
        <button className={'tab' + (tab === 'train' ? ' active' : '')} onClick={() => setTab('train')}>
          Train
          <span className={'badge' + (dueCount === 0 ? ' zero' : '')}>{dueCount}</span>
        </button>
        <button className={'tab' + (tab === 'browse' ? ' active' : '')} onClick={() => setTab('browse')}>
          My Lines
        </button>
        <button className={'tab' + (tab === 'review' ? ' active' : '')} onClick={() => setTab('review')}>
          Review
        </button>
        <button className={'tab' + (tab === 'game-import' ? ' active' : '')} onClick={() => setTab('game-import')}>
          Import
        </button>
        <button className={'tab' + (tab === 'new-opening' ? ' active' : '')} onClick={() => setTab('new-opening')}>
          New Opening
        </button>
        <button className={'tab' + (tab === 'repertoires' ? ' active' : '')} onClick={() => setTab('repertoires')}>
          Repertoires
        </button>
        <button className={'tab' + (tab === 'history' ? ' active' : '')} onClick={() => setTab('history')}>
          Trivia
          <span className={'badge' + (historyDueCount === 0 ? ' zero' : '')}>{historyDueCount}</span>
        </button>
        <button className={'tab' + (tab === 'settings' ? ' active' : '')} onClick={() => setTab('settings')}>
          Settings
        </button>
        <button className={'tab' + (tab === 'account' ? ' active' : '')} onClick={() => setTab('account')}>
          Account
        </button>
        <span className="spacer" />
        <details className="nav-tools">
          <summary>Data</summary>
          <div className="nav-tools-menu">
            <button onClick={handleExport} title="Download a Chesski JSON backup">Backup</button>
            <button onClick={handleImportClick} title="Restore a Chesski JSON backup">Restore</button>
          </div>
        </details>
        <input type="file" accept="application/json" ref={fileInputRef} onChange={handleImportFile} style={{ display: 'none' }} />
      </div>

      {showFirstRunOnboarding && (
        <FirstRunOnboarding
          onNo={handleFirstRunNo}
          onYes={handleFirstRunYes}
          onSkip={handleFirstRunSkip}
        />
      )}

      {starterNotice && tab === 'train' && (
        <div className="onboarding-inline-note">
          <span>OK, we're going to start with teaching you one white opening first.</span>
          <button onClick={() => setStarterNotice(false)}>Dismiss</button>
        </div>
      )}

      {importNotice && tab === 'game-import' && (
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
              refreshKey={refreshKey}
              onChoose={handleChooseRepertoire}
            />
          )}
          {tab === 'train' && <TrainMode repertoire={activeRep} onDataChange={onDataChange} refreshKey={refreshKey} boardSize={boardSize} onBoardSizeChange={setBoardSize} />}
          {tab === 'browse' && <BrowseMode repertoire={activeRep} onDataChange={onDataChange} refreshKey={refreshKey} boardSize={boardSize} onBoardSizeChange={setBoardSize} />}
          {tab === 'review' && <ReviewMode repertoire={activeRep} onDataChange={onDataChange} />}
          {tab === 'game-import' && (
            <GameImportMode
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
            />
          )}
          {tab === 'repertoires' && (
            <>
              <RepertoiresMode
                repertoires={repertoires}
                activeRepId={activeRepId}
                onSelect={setActiveRepId}
                onOpen={handleOpenRepertoire}
                onCreated={handleCreated}
                onChanged={async () => { await reloadRepertoires(); onDataChange(); }}
                onDelete={handleDelete}
                onNewOpening={() => setTab('new-opening')}
              />
              <details className="collapsible custom-tools-panel">
                <summary>Custom / import tools</summary>
                <div className="panel">
                  <NewRepertoireCreator repertoires={repertoires} onCreated={handleCreated} />
                </div>
              </details>
            </>
          )}
          {tab === 'history' && <HistoryMode onProgressChange={onDataChange} />}
          {tab === 'settings' && <SettingsMode />}
          {tab === 'account' && <AccountMode onRestored={onAccountRestored} onTokenChanged={onAccountRestored} />}
        </>
      ) : (
        <div className="panel">Select a repertoire above.</div>
      )}
    </div>
  );
}

function FirstRunOnboarding({ onNo, onYes, onSkip }: {
  onNo: () => Promise<void>;
  onYes: () => Promise<void>;
  onSkip: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<'no' | 'yes' | 'skip' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: 'no' | 'yes' | 'skip', action: () => Promise<void>) {
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

  return (
    <div className="modal-backdrop soft">
      <div className="modal onboarding-modal">
        <div className="onboarding-mascot-row">
          <img src="/chesski-256.png" alt="" className="onboarding-mascot" />
          <div>
            <h2>Do you know any chess openings?</h2>
            <p className="muted">
              Chesski can either start teaching you a prepared starter set, or help you turn your own games into a repertoire.
            </p>
          </div>
        </div>
        <div className="onboarding-choice-grid">
          <button className="primary" onClick={() => void run('no', onNo)} disabled={!!busy}>
            {busy === 'no' ? 'Preparing...' : 'No, teach me'}
          </button>
          <button onClick={() => void run('yes', onYes)} disabled={!!busy}>
            {busy === 'yes' ? 'Opening My Games...' : 'Yes, I know some'}
          </button>
          <button onClick={() => void run('skip', onSkip)} disabled={!!busy}>
            Skip
          </button>
        </div>
        <div className="muted small onboarding-starter-copy">
          Starter set: London System as White, Caro-Kann as Black, and QGD as Black.
        </div>
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
}

function HomeMode({ repertoires, activeRepId, refreshKey, onChoose }: {
  repertoires: Repertoire[];
  activeRepId: string | null;
  refreshKey: number;
  onChoose: (id: string, nextTab?: Tab) => void;
}) {
  const [statsByRep, setStatsByRep] = useState<Record<string, HomeRepStats>>({});
  const activeRep = repertoires.find(rep => rep.id === activeRepId) ?? repertoires[0] ?? null;
  const activeStats = activeRep ? statsByRep[activeRep.id] : undefined;
  const mainRepertoires = repertoires.filter(rep => (rep.projectKind ?? 'standard') !== 'siloed');
  const sideRepertoires = repertoires.filter(rep => rep.projectKind === 'siloed');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const now = new Date();
      const entries = await Promise.all(repertoires.map(async rep => {
        const edges = await getEdgesForRepertoire(rep.id);
        const userEdges = edges.filter(edge => edge.mover === rep.color);
        const stats: HomeRepStats = {
          totalMoves: edges.length,
          userMoves: userEdges.length,
          dueMoves: userEdges.filter(edge => isDue(edge, now)).length,
          learnedMoves: userEdges.filter(edge => edge.reps > 0).length,
        };
        return [rep.id, stats] as const;
      }));
      if (!cancelled) setStatsByRep(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [repertoires, refreshKey]);

  if (!activeRep) return <div className="panel">Create a repertoire to start studying.</div>;

  return (
    <div className="home-layout">
      <div className="panel home-current">
        <div>
          <h3>Current study</h3>
          <div className="home-current-title">{activeRep.name}</div>
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
            <button onClick={() => onChoose(activeRep.id, 'browse')}>My Lines</button>
            <button onClick={() => onChoose(activeRep.id, 'review')}>Analyze My Game</button>
          </div>
        </div>
        <div className="home-board-preview" style={{ pointerEvents: 'none' }}>
          <Board
            fen={activeRep.rootFen}
            orientation={activeRep.color === 'w' ? 'white' : 'black'}
            onMove={() => false}
            allowMoves={false}
            size={180}
          />
        </div>
      </div>

      <div className="home-picker">
        <HomeRepertoireGroup
          title="main repertoires"
          repertoires={mainRepertoires}
          activeRepId={activeRep.id}
          statsByRep={statsByRep}
          onChoose={onChoose}
        />
        <HomeRepertoireGroup
          title="side repertoires"
          repertoires={sideRepertoires}
          activeRepId={activeRep.id}
          statsByRep={statsByRep}
          onChoose={onChoose}
        />
      </div>
    </div>
  );
}

function HomeRepertoireGroup({ title, repertoires, activeRepId, statsByRep, onChoose }: {
  title: string;
  repertoires: Repertoire[];
  activeRepId: string;
  statsByRep: Record<string, HomeRepStats>;
  onChoose: (id: string, nextTab?: Tab) => void;
}) {
  return (
    <div className="panel">
      <h3>{title}</h3>
      {repertoires.length === 0 ? (
        <div className="settings-empty-drop">Nothing here yet</div>
      ) : (
        <div className="home-rep-grid">
          {repertoires.map(rep => (
            <HomeRepertoireCard
              key={rep.id}
              rep={rep}
              active={rep.id === activeRepId}
              stats={statsByRep[rep.id]}
              onChoose={onChoose}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HomeRepertoireCard({ rep, active, stats, onChoose }: {
  rep: Repertoire;
  active: boolean;
  stats?: HomeRepStats;
  onChoose: (id: string, nextTab?: Tab) => void;
}) {
  return (
    <div className={'home-rep-card' + (active ? ' active' : '')} onClick={() => onChoose(rep.id)} style={{ cursor: 'pointer' }}>
      <div className="home-rep-main">
        <div className="home-rep-title">{rep.name}</div>
        <div className="muted small">{openingLabel(rep)} - {rep.color === 'w' ? 'White' : 'Black'}</div>
      </div>
      <div className="home-mini-stats">
        <span><strong>{stats?.dueMoves ?? 0}</strong> due</span>
        <span><strong>{stats?.learnedMoves ?? 0}</strong> / {stats?.userMoves ?? 0} learned</span>
      </div>
      <div className="row home-rep-actions">
        <button className="primary" onClick={e => { e.stopPropagation(); onChoose(rep.id, 'train'); }}>Train</button>
        <button onClick={e => { e.stopPropagation(); onChoose(rep.id, 'browse'); }}>My Lines</button>
      </div>
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
  return opening?.name ?? 'Custom opening';
}

function repKindLabel(rep: Repertoire): string {
  return (rep.projectKind ?? 'standard') === 'siloed' ? 'side repertoire' : 'main repertoire';
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
          Side repertoire
          <span className="muted small"> can contradict your main repertoire</span>
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

export default App;
