/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getMeta, setMeta } from './storage';

export type BoardThemeKey = 'classic' | 'blue' | 'green' | 'gray';
export type PieceSetKey = 'staunton' | 'fantasy' | 'spatial' | 'chessnut';

export interface BoardPreferences {
  boardTheme: BoardThemeKey;
  pieceSet: PieceSetKey;
  animationsEnabled: boolean;
  animationSpeedMs: number;
  soundEnabled: boolean;
}

export const DEFAULT_BOARD_PREFERENCES: BoardPreferences = {
  boardTheme: 'classic',
  pieceSet: 'staunton',
  animationsEnabled: true,
  animationSpeedMs: 110,
  soundEnabled: false,
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
  const savedBoardTheme = saved?.boardTheme;
  const savedPieceSet = migratePieceSet(saved?.pieceSet);
  const boardTheme = BOARD_THEME_OPTIONS.find(option => option.key === savedBoardTheme)?.key
    ?? DEFAULT_BOARD_PREFERENCES.boardTheme;
  const pieceSet = PIECE_SET_OPTIONS.find(option => option.key === savedPieceSet)?.key
    ?? DEFAULT_BOARD_PREFERENCES.pieceSet;
  const animationSpeedMs = typeof saved?.animationSpeedMs === 'number'
    ? Math.max(40, Math.min(260, Math.round(saved.animationSpeedMs)))
    : DEFAULT_BOARD_PREFERENCES.animationSpeedMs;

  return {
    boardTheme,
    pieceSet,
    animationsEnabled: typeof saved?.animationsEnabled === 'boolean'
      ? saved.animationsEnabled
      : DEFAULT_BOARD_PREFERENCES.animationsEnabled,
    animationSpeedMs,
    soundEnabled: typeof saved?.soundEnabled === 'boolean'
      ? saved.soundEnabled
      : DEFAULT_BOARD_PREFERENCES.soundEnabled,
  };
}

function migratePieceSet(pieceSet: unknown): PieceSetKey | undefined {
  if (pieceSet === 'symbols') return 'fantasy';
  if (pieceSet === 'letters') return 'chessnut';
  return typeof pieceSet === 'string' ? pieceSet as PieceSetKey : undefined;
}
