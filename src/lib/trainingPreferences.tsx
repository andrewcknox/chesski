/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getMeta, setMeta } from './storage';

export interface TrainingPreferences {
  learnLineDepth: number;
  reviewSessionLength: number;
  useLineAwareReview: boolean;
  reviewLinePlaybackDelayMs: number;
  relearnMinutes: number;
}

export const DEFAULT_TRAINING_PREFERENCES: TrainingPreferences = {
  learnLineDepth: 5,
  reviewSessionLength: 10,
  useLineAwareReview: true,
  reviewLinePlaybackDelayMs: 80,
  relearnMinutes: 5,
};

export const MIN_REVIEW_LINE_PLAYBACK_DELAY_MS = 40;
export const MAX_REVIEW_LINE_PLAYBACK_DELAY_MS = 600;
export const MIN_RELEARN_MINUTES = 1;
export const MAX_RELEARN_MINUTES = 60;

const META_TRAINING_PREFERENCES = 'training_preferences_v1';

interface TrainingPreferencesContextValue {
  preferences: TrainingPreferences;
  updatePreferences: (patch: Partial<TrainingPreferences>) => Promise<void>;
}

const TrainingPreferencesContext = createContext<TrainingPreferencesContextValue>({
  preferences: DEFAULT_TRAINING_PREFERENCES,
  updatePreferences: async () => {},
});

export function TrainingPreferencesProvider({ children }: { children: React.ReactNode }) {
  const [preferences, setPreferences] = useState<TrainingPreferences>(DEFAULT_TRAINING_PREFERENCES);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await getMeta<Partial<TrainingPreferences>>(META_TRAINING_PREFERENCES);
      if (!cancelled) setPreferences(normalizeTrainingPreferences(saved));
    })();
    return () => { cancelled = true; };
  }, []);

  const value = useMemo<TrainingPreferencesContextValue>(() => ({
    preferences,
    updatePreferences: async (patch) => {
      const next = normalizeTrainingPreferences({ ...preferences, ...patch });
      setPreferences(next);
      await setMeta(META_TRAINING_PREFERENCES, next);
    },
  }), [preferences]);

  return (
    <TrainingPreferencesContext.Provider value={value}>
      {children}
    </TrainingPreferencesContext.Provider>
  );
}

export function useTrainingPreferences() {
  return useContext(TrainingPreferencesContext);
}

function normalizeTrainingPreferences(saved?: Partial<TrainingPreferences>): TrainingPreferences {
  return {
    learnLineDepth: clampInteger(saved?.learnLineDepth, 3, 8, DEFAULT_TRAINING_PREFERENCES.learnLineDepth),
    reviewSessionLength: clampInteger(saved?.reviewSessionLength, 5, 30, DEFAULT_TRAINING_PREFERENCES.reviewSessionLength),
    useLineAwareReview: typeof saved?.useLineAwareReview === 'boolean'
      ? saved.useLineAwareReview
      : DEFAULT_TRAINING_PREFERENCES.useLineAwareReview,
    reviewLinePlaybackDelayMs: clampInteger(
      saved?.reviewLinePlaybackDelayMs,
      MIN_REVIEW_LINE_PLAYBACK_DELAY_MS,
      MAX_REVIEW_LINE_PLAYBACK_DELAY_MS,
      DEFAULT_TRAINING_PREFERENCES.reviewLinePlaybackDelayMs,
    ),
    relearnMinutes: clampInteger(
      saved?.relearnMinutes,
      MIN_RELEARN_MINUTES,
      MAX_RELEARN_MINUTES,
      DEFAULT_TRAINING_PREFERENCES.relearnMinutes,
    ),
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number'
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}
