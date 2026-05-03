import { getMeta, setMeta } from './storage';

const META_RECOMMENDATION_SETTINGS = 'recommendation_settings_v1';

export type PlayerKey = 'self' | 'morphy' | 'fischer' | 'kasparov' | 'carlsen';
export type DatabaseSourceKey = 'masters' | 'lichess-2000';
export type RecommendationSourceKey = PlayerKey | DatabaseSourceKey;

export interface PlayerChoice {
  key: PlayerKey;
  name: string;
}

export type RecommendationSourceChoice =
  | { key: PlayerKey; name: string; kind: 'player-book' }
  | { key: DatabaseSourceKey; name: string; kind: 'database' };

export const PLAYER_CHOICES: PlayerChoice[] = [
  { key: 'self', name: 'My games' },
  { key: 'morphy', name: 'Paul Morphy' },
  { key: 'fischer', name: 'Bobby Fischer' },
  { key: 'kasparov', name: 'Garry Kasparov' },
  { key: 'carlsen', name: 'Magnus Carlsen' },
];

export const RECOMMENDATION_CHOICES: RecommendationSourceChoice[] = [
  ...PLAYER_CHOICES.map(player => ({ ...player, kind: 'player-book' as const })),
  { key: 'masters', name: 'Masters database', kind: 'database' },
  { key: 'lichess-2000', name: 'Lichess 2000+ games', kind: 'database' },
];

export interface RecommendationSettings {
  playerPriorities: Record<RecommendationSourceKey, number>;
  playerBookMaxCpLoss: number;
  stealPaulMorphy?: boolean;
}

export const DEFAULT_RECOMMENDATION_SETTINGS: RecommendationSettings = {
  playerBookMaxCpLoss: 75,
  playerPriorities: {
    self: 1,
    masters: 2,
    'lichess-2000': 3,
    morphy: 0,
    fischer: 0,
    kasparov: 0,
    carlsen: 0,
  },
};

export async function getRecommendationSettings(): Promise<RecommendationSettings> {
  const saved = await getMeta<Partial<RecommendationSettings>>(META_RECOMMENDATION_SETTINGS);
  const merged = {
    ...DEFAULT_RECOMMENDATION_SETTINGS,
    ...(saved ?? {}),
    playerPriorities: {
      ...DEFAULT_RECOMMENDATION_SETTINGS.playerPriorities,
      ...(saved?.playerPriorities ?? {}),
    },
    playerBookMaxCpLoss: saved?.playerBookMaxCpLoss ?? DEFAULT_RECOMMENDATION_SETTINGS.playerBookMaxCpLoss,
  };
  if (saved?.stealPaulMorphy && merged.playerPriorities.morphy === 0) {
    merged.playerPriorities.morphy = 1;
  }
  return merged;
}

export async function setRecommendationSettings(settings: RecommendationSettings): Promise<void> {
  await setMeta(META_RECOMMENDATION_SETTINGS, {
    playerPriorities: settings.playerPriorities,
    playerBookMaxCpLoss: settings.playerBookMaxCpLoss,
  });
}

export function getEnabledPlayerOrder(settings: RecommendationSettings): PlayerChoice[] {
  return PLAYER_CHOICES
    .filter(player => settings.playerPriorities[player.key] > 0)
    .sort((a, b) => settings.playerPriorities[a.key] - settings.playerPriorities[b.key]);
}

export function getEnabledRecommendationOrder(settings: RecommendationSettings): RecommendationSourceChoice[] {
  return RECOMMENDATION_CHOICES
    .filter(source => settings.playerPriorities[source.key] > 0)
    .sort((a, b) => settings.playerPriorities[a.key] - settings.playerPriorities[b.key]);
}
