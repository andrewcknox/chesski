import { useEffect, useRef, useState } from 'react';
import {
  clearUserPlayerBook,
  importUserPlayerBookFromPgn,
} from '../lib/playerBook';
import {
  DEFAULT_RECOMMENDATION_SETTINGS,
  getRecommendationSettings,
  setRecommendationSettings,
  type RecommendationSettings,
} from '../lib/recommendationSettings';
import {
  ACCENT_COLOR_OPTIONS,
  APP_THEME_OPTIONS,
  BOARD_THEME_OPTIONS,
  PIECE_SET_OPTIONS,
  type AccentColorKey,
  type AppThemeKey,
  type BoardThemeKey,
  type PieceSetKey,
  useBoardPreferences,
} from '../lib/boardPreferences';
import {
  MAX_REVIEW_LINE_PLAYBACK_DELAY_MS,
  MIN_REVIEW_LINE_PLAYBACK_DELAY_MS,
  useTrainingPreferences,
} from '../lib/trainingPreferences';
import { HistoryMode } from './HistoryMode';
import { HelpDocsModal } from './HelpDocsMode';

const MIN_ANIMATION_MS = 40;
const MAX_ANIMATION_MS = 260;

const ALGORITHM_GUIDE_STEPS = [
  {
    title: 'Great Players',
    body: 'Which great players do you want to take the games of? Put your own games, classic players, masters, or Lichess 2000+ in the order Chesski should consult them.',
  },
  {
    title: 'Move Selection',
    body: 'Chesski checks those sources in order, looks for moves with practical support, and keeps your repertoire to one clear continuation at each of your decision points.',
  },
  {
    title: 'Quality Guard',
    body: 'Player-line quality guard is the new name for the old engine-check idea. If a player-book move loses too much, Chesski asks the engine and master data for a cleaner continuation.',
  },
];

export function SettingsMode({ onTriviaProgressChange, onOpenGlobalAlgorithm, onRestartOnboarding }: {
  onTriviaProgressChange: () => void;
  onOpenGlobalAlgorithm: () => void;
  onRestartOnboarding: () => void | Promise<void>;
}) {
  const { preferences: boardPreferences, updatePreferences } = useBoardPreferences();
  const { preferences: trainingPreferences, updatePreferences: updateTrainingPreferences } = useTrainingPreferences();
  const [settings, setSettingsState] = useState<RecommendationSettings>(DEFAULT_RECOMMENDATION_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideStep, setGuideStep] = useState(0);
  const [helpDocsOpen, setHelpDocsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    (async () => {
      setSettingsState(await getRecommendationSettings());
      setLoaded(true);
    })();
  }, []);

  async function update(next: RecommendationSettings) {
    setSettingsState(next);
    await setRecommendationSettings(next);
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportStatus(null);
    try {
      const stats = await importUserPlayerBookFromPgn(await file.text(), importName);
      setImportStatus(`Imported ${stats.indexedGames.toLocaleString()} games and ${stats.positions.toLocaleString()} positive positions.`);
      await update({
        ...settings,
        playerPriorities: { ...settings.playerPriorities, self: 1 },
      });
    } catch (err) {
      setImportStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  }

  async function handleClearUserBook() {
    if (!window.confirm('Remove the imported games book?')) return;
    await clearUserPlayerBook();
    setImportStatus('Removed imported games.');
  }

  if (!loaded) return null;

  const animationSpeedSliderValue = MAX_ANIMATION_MS + MIN_ANIMATION_MS - boardPreferences.animationSpeedMs;
  const reviewLinePlaybackSliderValue =
    MAX_REVIEW_LINE_PLAYBACK_DELAY_MS + MIN_REVIEW_LINE_PLAYBACK_DELAY_MS - trainingPreferences.reviewLinePlaybackDelayMs;

  return (
    <div className="layout settings-layout">
      {guideOpen && (
        <AlgorithmGuide
          step={guideStep}
          onPrevious={() => setGuideStep(step => Math.max(0, step - 1))}
          onNext={() => setGuideStep(step => Math.min(ALGORITHM_GUIDE_STEPS.length - 1, step + 1))}
          onClose={() => setGuideOpen(false)}
        />
      )}

      {helpDocsOpen && <HelpDocsModal onClose={() => setHelpDocsOpen(false)} />}

      <div className="page-header settings-page-header">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>Study controls</h1>
          <p>Board feel, training cadence, and source defaults. Quiet knobs, sharp prep.</p>
        </div>
      </div>

      <div className="settings-columns">
        <div className="settings-col">
          <div className="panel algorithm-guide-panel">
            <img src="/chesski-256.png" alt="" className="algorithm-guide-sprite" />
            <div>
              <h3>Algorithm guide</h3>
              <div className="muted small settings-copy">
                A quick click-through tour of source order, move selection, and the player-line quality guard.
              </div>
            </div>
            <button onClick={() => { setGuideStep(0); setGuideOpen(true); }}>Guide me</button>
          </div>

          <div className="panel algorithm-guide-panel">
            <img src="/chesski-256.png" alt="" className="algorithm-guide-sprite" />
            <div>
              <h3>How Chesski works</h3>
              <div className="muted small settings-copy">
                Reference page for the parts of Chesski that aren't obvious. Currently covers the
                spaced-repetition system; will grow.
              </div>
            </div>
            <button onClick={() => setHelpDocsOpen(true)}>Open help &amp; docs</button>
          </div>

          <div className="panel board-preferences-panel">
            <h3>Board and pieces</h3>
            <div className="settings-copy muted small">
              Tune the board without changing your repertoire or training data.
            </div>
            <div className="board-preference-group">
              <strong>Appearance</strong>
              <div className="segmented">
                {APP_THEME_OPTIONS.map(theme => (
                  <button
                    key={theme.key}
                    className={boardPreferences.appTheme === theme.key ? 'active' : ''}
                    onClick={() => void updatePreferences({ appTheme: theme.key as AppThemeKey })}
                  >
                    {theme.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="board-preference-group">
              <strong>Accent color</strong>
              <div className="accent-color-grid">
                {ACCENT_COLOR_OPTIONS.map(option => (
                  <button
                    key={option.key}
                    className={'accent-color-choice' + (boardPreferences.accentColor === option.key ? ' active' : '')}
                    title={option.name}
                    onClick={() => void updatePreferences({ accentColor: option.key as AccentColorKey })}
                  >
                    <span className="accent-color-swatch" style={{ background: option.swatch }} />
                    <span className="accent-color-label">{option.name}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="board-preference-group">
              <strong>Board color</strong>
              <div className="board-theme-grid">
                {BOARD_THEME_OPTIONS.map(theme => (
                  <button
                    key={theme.key}
                    className={'board-theme-choice' + (boardPreferences.boardTheme === theme.key ? ' active' : '')}
                    onClick={() => void updatePreferences({ boardTheme: theme.key as BoardThemeKey })}
                  >
                    <span className="board-theme-swatch" style={{ background: `linear-gradient(135deg, ${theme.light} 0 50%, ${theme.dark} 50% 100%)` }} />
                    <span>{theme.name}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="board-preference-group">
              <strong>Pieces</strong>
              <div className="segmented">
                {PIECE_SET_OPTIONS.map(pieceSet => (
                  <button
                    key={pieceSet.key}
                    className={boardPreferences.pieceSet === pieceSet.key ? 'active' : ''}
                    onClick={() => void updatePreferences({ pieceSet: pieceSet.key as PieceSetKey })}
                  >
                    {pieceSet.name}
                  </button>
                ))}
              </div>
            </div>
            <label className="board-preference-check">
              <input
                type="checkbox"
                checked={boardPreferences.animationsEnabled}
                onChange={e => void updatePreferences({ animationsEnabled: e.target.checked })}
              />
              <span>Animate piece movement</span>
            </label>
            <div className="board-preference-speed">
              <label htmlFor="animation-speed">Animation speed</label>
              <input
                id="animation-speed"
                type="range"
                min={MIN_ANIMATION_MS}
                max={MAX_ANIMATION_MS}
                step={10}
                value={animationSpeedSliderValue}
                disabled={!boardPreferences.animationsEnabled}
                onChange={e => void updatePreferences({ animationSpeedMs: MAX_ANIMATION_MS + MIN_ANIMATION_MS - Number(e.target.value) })}
              />
              <span className="mono small">{boardPreferences.animationSpeedMs}ms</span>
            </div>
            <label className="board-preference-check">
              <input
                type="checkbox"
                checked={boardPreferences.soundEnabled}
                onChange={e => void updatePreferences({ soundEnabled: e.target.checked })}
              />
              <span>Move sound</span>
            </label>
            <label className="board-preference-check">
              <input
                type="checkbox"
                checked={boardPreferences.hideDragGhost}
                onChange={e => void updatePreferences({ hideDragGhost: e.target.checked })}
              />
              <span>Use origin-square highlight while dragging</span>
            </label>
          </div>

          <div className="panel">
            <h3>Algorithm defaults</h3>
            <div className="muted small settings-copy">
              Global source order is the fallback for every repertoire and opening folder. Repertoire and opening-specific Algorithm buttons can override it.
            </div>
            <button className="primary" onClick={onOpenGlobalAlgorithm}>Open global Algorithm</button>
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
        </div>

        <div className="settings-col">
          <div className="panel">
            <h3>Onboarding</h3>
            <div className="muted small settings-copy">
              Reopen the first-run guide for choosing a side, adding an opening, setting source preferences, and starting training.
            </div>
            <button onClick={() => void onRestartOnboarding()}>Restart onboarding</button>
          </div>

          <div className="panel training-preferences-panel">
            <h3>Training sessions</h3>
            <div className="settings-copy muted small">
              Set how much new prep Chesski introduces and how many review cards a session serves up.
            </div>
            <div className="training-preference-row">
              <label htmlFor="learn-line-depth">
                <strong>New line depth</strong>
                <span className="muted small">Your moves per Learn line</span>
              </label>
              <input
                id="learn-line-depth"
                type="range"
                min={3}
                max={8}
                step={1}
                value={trainingPreferences.learnLineDepth}
                onChange={e => void updateTrainingPreferences({ learnLineDepth: Number(e.target.value) })}
              />
              <span className="mono small">{trainingPreferences.learnLineDepth}</span>
            </div>
            <div className="training-preference-row">
              <label htmlFor="review-session-length">
                <strong>Review length</strong>
                <span className="muted small">Cards per Review session</span>
              </label>
              <input
                id="review-session-length"
                type="range"
                min={5}
                max={30}
                step={1}
                value={trainingPreferences.reviewSessionLength}
                onChange={e => void updateTrainingPreferences({ reviewSessionLength: Number(e.target.value) })}
              />
              <span className="mono small">{trainingPreferences.reviewSessionLength}</span>
            </div>
            <div className="training-preference-row">
              <label htmlFor="line-aware-review">
                <strong>Line-aware review</strong>
                <span className="muted small">Auto-play context moves, prompt only on due cards (Chessable-style). Turn off to revert to flat one-card-at-a-time review.</span>
              </label>
              <input
                id="line-aware-review"
                type="checkbox"
                checked={trainingPreferences.useLineAwareReview}
                onChange={e => void updateTrainingPreferences({ useLineAwareReview: e.target.checked })}
              />
            </div>
            <div className="training-preference-row">
              <label htmlFor="review-line-playback-speed">
                <strong>Review line playback speed</strong>
                <span className="muted small">How quickly context moves auto-play between due cards</span>
              </label>
              <div className="preference-range-with-labels">
                <input
                  id="review-line-playback-speed"
                  type="range"
                  min={MIN_REVIEW_LINE_PLAYBACK_DELAY_MS}
                  max={MAX_REVIEW_LINE_PLAYBACK_DELAY_MS}
                  step={10}
                  value={reviewLinePlaybackSliderValue}
                  onChange={e => void updateTrainingPreferences({
                    reviewLinePlaybackDelayMs:
                      MAX_REVIEW_LINE_PLAYBACK_DELAY_MS + MIN_REVIEW_LINE_PLAYBACK_DELAY_MS - Number(e.target.value),
                  })}
                />
                <div className="range-label-row">
                  <span>Slower</span>
                  <span>Faster</span>
                </div>
              </div>
              <span className="mono small">{trainingPreferences.reviewLinePlaybackDelayMs}ms</span>
            </div>
          </div>

        </div>
      </div>

      <details className="settings-wide-section collapsible">
        <summary><strong>Trivia</strong> <span className="muted small">— Practice chess history cards and manage trivia progress.</span></summary>
        <HistoryMode onProgressChange={onTriviaProgressChange} />
      </details>
    </div>
  );
}

function AlgorithmGuide({ step, onPrevious, onNext, onClose }: {
  step: number;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const current = ALGORITHM_GUIDE_STEPS[step];
  const isLast = step === ALGORITHM_GUIDE_STEPS.length - 1;

  return (
    <div className="modal-backdrop soft">
      <div className="modal algorithm-guide-modal">
        <div className="algorithm-dialogue-head">
          <img src="/chesski-256.png" alt="" className="algorithm-dialogue-sprite" />
          <div>
            <h2>{current.title}</h2>
            <p>{current.body}</p>
          </div>
        </div>
        <div className="algorithm-dialogue-progress">
          {ALGORITHM_GUIDE_STEPS.map((_, index) => (
            <span key={index} className={index === step ? 'active' : ''} />
          ))}
        </div>
        <div className="row algorithm-dialogue-actions">
          <button onClick={onPrevious} disabled={step === 0}>Back</button>
          <button className="primary" onClick={isLast ? onClose : onNext}>
            {isLast ? 'Done' : 'Next'}
          </button>
          <button onClick={onClose}>Skip</button>
        </div>
      </div>
    </div>
  );
}
