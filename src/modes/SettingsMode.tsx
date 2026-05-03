import { useEffect, useRef, useState } from 'react';
import {
  clearUserPlayerBook,
  getPlayerBookStats,
  importUserPlayerBookFromPgn,
  type PlayerBookStats,
} from '../lib/playerBook';
import {
  DEFAULT_RECOMMENDATION_SETTINGS,
  RECOMMENDATION_CHOICES,
  getRecommendationSettings,
  setRecommendationSettings,
  type RecommendationSourceChoice,
  type RecommendationSourceKey,
  type RecommendationSettings,
} from '../lib/recommendationSettings';

export function SettingsMode() {
  const [settings, setSettingsState] = useState<RecommendationSettings>(DEFAULT_RECOMMENDATION_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [bookStats, setBookStats] = useState<PlayerBookStats[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    (async () => {
      setSettingsState(await getRecommendationSettings());
      setLoaded(true);
      try {
        setBookStats(await getPlayerBookStats());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  async function update(next: RecommendationSettings) {
    setSettingsState(next);
    await setRecommendationSettings(next);
  }

  async function reloadStats() {
    setBookStats(await getPlayerBookStats());
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setError(null);
    setImportStatus(null);
    try {
      const stats = await importUserPlayerBookFromPgn(await file.text(), importName);
      await reloadStats();
      setImportStatus(`Imported ${stats.indexedGames.toLocaleString()} games and ${stats.positions.toLocaleString()} positive positions.`);
      await update({
        ...settings,
        playerPriorities: { ...settings.playerPriorities, self: 1 },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  }

  async function handleClearUserBook() {
    if (!window.confirm('Remove the imported games book?')) return;
    await clearUserPlayerBook();
    await reloadStats();
    setImportStatus('Removed imported games.');
  }

  function isSourceKey(value: string | null): value is RecommendationSourceKey {
    return RECOMMENDATION_CHOICES.some(source => source.key === value);
  }

  function activeSourceKeys(): RecommendationSourceKey[] {
    return RECOMMENDATION_CHOICES
      .filter(source => settings.playerPriorities[source.key] > 0)
      .sort((a, b) => settings.playerPriorities[a.key] - settings.playerPriorities[b.key])
      .map(source => source.key);
  }

  function prioritiesFromActive(nextActive: RecommendationSourceKey[]): RecommendationSettings['playerPriorities'] {
    const next = { ...DEFAULT_RECOMMENDATION_SETTINGS.playerPriorities };
    for (const source of RECOMMENDATION_CHOICES) next[source.key] = 0;
    nextActive.forEach((key, index) => {
      next[key] = index + 1;
    });
    return next;
  }

  async function setActiveSources(nextActive: RecommendationSourceKey[]) {
    await update({
      ...settings,
      playerPriorities: prioritiesFromActive(nextActive),
    });
  }

  async function setPlayerBookMaxCpLoss(value: number) {
    await update({
      ...settings,
      playerBookMaxCpLoss: value,
    });
  }

  function draggedSource(e: React.DragEvent): RecommendationSourceKey | null {
    const fromEvent = e.dataTransfer.getData('text/plain');
    return isSourceKey(fromEvent) ? fromEvent : null;
  }

  function startDrag(e: React.DragEvent, sourceKey: RecommendationSourceKey) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sourceKey);
  }

  function dropIntoActive(e: React.DragEvent, index?: number) {
    e.preventDefault();
    e.stopPropagation();
    const key = draggedSource(e);
    if (!key) return;
    const next = activeSourceKeys().filter(activeKey => activeKey !== key);
    const target = index ?? next.length;
    next.splice(Math.max(0, Math.min(target, next.length)), 0, key);
    void setActiveSources(next);
  }

  function dropIntoInactive(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const key = draggedSource(e);
    if (!key) return;
    void setActiveSources(activeSourceKeys().filter(activeKey => activeKey !== key));
  }

  if (!loaded) return null;

  const playerLabels = new Map<RecommendationSourceKey, string>(
    bookStats.map(player => [player.key, player.name] as [RecommendationSourceKey, string])
  );
  const labelForSource = (source: RecommendationSourceChoice) => playerLabels.get(source.key) ?? source.name;
  const activeKeys = activeSourceKeys();
  const activeSources = activeKeys.map(key => RECOMMENDATION_CHOICES.find(source => source.key === key)).filter(Boolean) as RecommendationSourceChoice[];
  const inactiveSources = RECOMMENDATION_CHOICES.filter(source => !activeKeys.includes(source.key));

  return (
    <div className="layout settings-layout">
      <div className="panel">
        <h3>Opening choices</h3>
        <div className="muted small settings-copy">
          Drag sources into the order you want Chesski to check. Imported PGNs show up here as your own stealable source. Player moves need a positive record and then pass the engine check below.
        </div>
        <div className="settings-drop-grid">
          <div
            className="settings-drop-column"
            onDragOver={e => e.preventDefault()}
            onDrop={e => dropIntoActive(e)}
          >
            <h4>Use first</h4>
            <div className="settings-player-list">
              {activeSources.length > 0 ? activeSources.map((source, index) => (
                <div
                  key={source.key}
                  className="settings-player-row"
                  draggable
                  onDragStart={e => startDrag(e, source.key)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => dropIntoActive(e, index)}
                >
                  <span className="settings-drag-grip" aria-hidden="true">::</span>
                  <span className="settings-player-rank">{index + 1}</span>
                  <span className="settings-player-name">{labelForSource(source)}</span>
                </div>
              )) : (
                <div className="settings-empty-drop">Drop sources here</div>
              )}
              <div className="settings-fallback-stack">
                <div className="settings-fallback-row stockfish">Stockfish</div>
              </div>
            </div>
          </div>
          <div
            className="settings-drop-column inactive"
            onDragOver={e => e.preventDefault()}
            onDrop={dropIntoInactive}
          >
            <h4>Don't use</h4>
            <div className="settings-player-list">
              {inactiveSources.length > 0 ? inactiveSources.map(source => (
                <div
                  key={source.key}
                  className="settings-player-row inactive"
                  draggable
                  onDragStart={e => startDrag(e, source.key)}
                >
                  <span className="settings-drag-grip" aria-hidden="true">::</span>
                  <span className="settings-player-name">{labelForSource(source)}</span>
                </div>
              )) : (
                <div className="settings-empty-drop">Drop sources here to turn them off</div>
              )}
            </div>
          </div>
        </div>
        <div className="settings-threshold-row">
          <div>
            <strong>Stolen line engine check</strong>
            <div className="muted small">Applies only to newly generated player-book lines.</div>
          </div>
          <select
            value={settings.playerBookMaxCpLoss}
            onChange={e => void setPlayerBookMaxCpLoss(Number(e.target.value))}
          >
            <option value={50}>Strict: 50 cp</option>
            <option value={75}>Balanced: 75 cp</option>
            <option value={100}>Faithful: 100 cp</option>
            <option value={150}>Loose: 150 cp</option>
          </select>
        </div>
      </div>

      <div className="panel">
        <h3>Add your games</h3>
        <div className="muted small settings-copy">
          Import a PGN file and enter the player name as it appears in those games. Chesski will add those moves to the ranked list above, just like Magnus, Morphy, or anyone else.
        </div>
        <div className="row settings-import-row">
          <input
            value={importName}
            onChange={e => setImportName(e.target.value)}
            placeholder="Player name in PGN"
          />
          <button onClick={() => fileInputRef.current?.click()} disabled={importing || !importName.trim()}>
            {importing ? 'Importing...' : 'Import PGN'}
          </button>
          <button onClick={handleClearUserBook} disabled={importing}>Clear imported</button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pgn,.txt"
            onChange={handleImportFile}
            style={{ display: 'none' }}
          />
        </div>
        {importStatus && <div className="small account-status good">{importStatus}</div>}
      </div>

      <div className="panel">
        <h3>Player book</h3>
        {bookStats.length > 0 ? (
          <div className="settings-book-list">
            {bookStats.map(player => (
              <div key={player.key} className="settings-book-row">
                <strong>{player.name}</strong>
                <span className="muted small">{player.indexedGames.toLocaleString()} games</span>
                <span className="muted small">{player.positions.toLocaleString()} positive positions</span>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="small" style={{ color: 'var(--bad)' }}>{error}</div>
        ) : (
          <div className="muted">Loading player books...</div>
        )}
      </div>
    </div>
  );
}
