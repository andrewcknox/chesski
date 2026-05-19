/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getMeta, setMeta } from './storage';

export type AppThemeKey = 'dark' | 'light';
export type BoardThemeKey = 'classic' | 'blue' | 'green' | 'gray';
export type PieceSetKey = 'staunton' | 'fantasy' | 'spatial' | 'chessnut';
export type AccentColorKey = 'bronze' | 'steel' | 'purple' | 'hacker' | 'chessdotcom' | 'gold' | 'yellow' | 'red' | 'pink';

export interface BoardPreferences {
  appTheme: AppThemeKey;
  boardTheme: BoardThemeKey;
  pieceSet: PieceSetKey;
  accentColor: AccentColorKey;
  animationsEnabled: boolean;
  animationSpeedMs: number;
  soundEnabled: boolean;
  hideDragGhost: boolean;
}

export const DEFAULT_BOARD_PREFERENCES: BoardPreferences = {
  appTheme: 'dark',
  boardTheme: 'classic',
  pieceSet: 'staunton',
  accentColor: 'bronze',
  animationsEnabled: true,
  animationSpeedMs: 110,
  soundEnabled: false,
  hideDragGhost: false,
};

export const BOARD_THEME_OPTIONS: Array<{ key: BoardThemeKey; name: string; light: string; dark: string }> = [
  { key: 'classic', name: 'Classic', light: '#f0d9b5', dark: '#b58863' },
  { key: 'blue', name: 'Blue', light: '#d9e7f4', dark: '#6f93b8' },
  { key: 'green', name: 'Green', light: '#e5e9c9', dark: '#7d945d' },
  { key: 'gray', name: 'Slate', light: '#d9dee5', dark: '#7f8792' },
];

export const PIECE_SET_OPTIONS: Array<{ key: PieceSetKey; name: string }> = [
  { key: 'staunton', name: 'Staunton' },
  { key: 'fantasy', name: 'Fantasy' },
  { key: 'spatial', name: 'Spatial' },
  { key: 'chessnut', name: 'Chessnut' },
];

export const APP_THEME_OPTIONS: Array<{ key: AppThemeKey; name: string }> = [
  { key: 'dark', name: 'Dark' },
  { key: 'light', name: 'Light' },
];

export const ACCENT_COLOR_OPTIONS: Array<{ key: AccentColorKey; name: string; swatch: string }> = [
  { key: 'bronze',     name: 'Bronze',         swatch: '#b58b4f' },
  { key: 'steel',     name: 'Steel Blue',     swatch: '#5b8db8' },
  { key: 'purple',    name: 'Purple',          swatch: '#9b59b6' },
  { key: 'hacker',    name: 'Hacker Green',   swatch: '#00e541' },
  { key: 'chessdotcom', name: 'Chess.com',    swatch: '#81b64c' },
  { key: 'gold',      name: 'Gold',            swatch: '#d4ac0d' },
  { key: 'yellow',    name: 'Yellow',          swatch: '#e8c040' },
  { key: 'red',       name: 'Red',             swatch: '#d24b48' },
  { key: 'pink',      name: 'Pink',            swatch: '#d63384' },
];

const META_BOARD_PREFERENCES = 'board_preferences_v1';

interface BoardPreferencesContextValue {
  preferences: BoardPreferences;
  updatePreferences: (patch: Partial<BoardPreferences>) => Promise<void>;
}

const BoardPreferencesContext = createContext<BoardPreferencesContextValue>({
  preferences: DEFAULT_BOARD_PREFERENCES,
  updatePreferences: async () => {},
});

export function BoardPreferencesProvider({ children }: { children: React.ReactNode }) {
  const [preferences, setPreferences] = useState<BoardPreferences>(DEFAULT_BOARD_PREFERENCES);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await getMeta<Partial<BoardPreferences>>(META_BOARD_PREFERENCES);
      if (!cancelled) setPreferences(normalizeBoardPreferences(saved));
    })();
    return () => { cancelled = true; };
  }, []);

  const value = useMemo<BoardPreferencesContextValue>(() => ({
    preferences,
    updatePreferences: async (patch) => {
      const next = normalizeBoardPreferences({ ...preferences, ...patch });
      setPreferences(next);
      await setMeta(META_BOARD_PREFERENCES, next);
    },
  }), [preferences]);

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.appTheme;
  }, [preferences.appTheme]);

  useEffect(() => {
    document.documentElement.dataset.accent = preferences.accentColor;
  }, [preferences.accentColor]);

  return (
    <BoardPreferencesContext.Provider value={value}>
      {children}
    </BoardPreferencesContext.Provider>
  );
}

export function useBoardPreferences() {
  return useContext(BoardPreferencesContext);
}

function normalizeBoardPreferences(saved?: Partial<BoardPreferences>): BoardPreferences {
  const appTheme = saved?.appTheme === 'light' || saved?.appTheme === 'dark'
    ? saved.appTheme
    : DEFAULT_BOARD_PREFERENCES.appTheme;
  const savedBoardTheme = saved?.boardTheme;
  const savedPieceSet = migratePieceSet(saved?.pieceSet);
  const boardTheme = BOARD_THEME_OPTIONS.find(option => option.key === savedBoardTheme)?.key
    ?? DEFAULT_BOARD_PREFERENCES.boardTheme;
  const pieceSet = PIECE_SET_OPTIONS.find(option => option.key === savedPieceSet)?.key
    ?? DEFAULT_BOARD_PREFERENCES.pieceSet;
  const accentColor = ACCENT_COLOR_OPTIONS.find(option => option.key === saved?.accentColor)?.key
    ?? DEFAULT_BOARD_PREFERENCES.accentColor;
  const animationSpeedMs = typeof saved?.animationSpeedMs === 'number'
    ? Math.max(40, Math.min(260, Math.round(saved.animationSpeedMs)))
    : DEFAULT_BOARD_PREFERENCES.animationSpeedMs;

  return {
    appTheme,
    boardTheme,
    pieceSet,
    accentColor,
    animationsEnabled: typeof saved?.animationsEnabled === 'boolean'
      ? saved.animationsEnabled
      : DEFAULT_BOARD_PREFERENCES.animationsEnabled,
    animationSpeedMs,
    soundEnabled: typeof saved?.soundEnabled === 'boolean'
      ? saved.soundEnabled
      : DEFAULT_BOARD_PREFERENCES.soundEnabled,
    hideDragGhost: typeof saved?.hideDragGhost === 'boolean'
      ? saved.hideDragGhost
      : DEFAULT_BOARD_PREFERENCES.hideDragGhost,
  };
}

function migratePieceSet(pieceSet: unknown): PieceSetKey | undefined {
  if (pieceSet === 'symbols') return 'fantasy';
  if (pieceSet === 'letters') return 'chessnut';
  return typeof pieceSet === 'string' ? pieceSet as PieceSetKey : undefined;
}
