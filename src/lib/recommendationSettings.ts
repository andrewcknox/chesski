import { getMeta, setMeta } from './storage';

const META_RECOMMENDATION_SETTINGS = 'recommendation_settings_v1';

export const PLAYER_CHOICES = [
  { key: 'self', name: 'My games' },
  { key: 'morphy', name: 'Paul Morphy' },
  { key: 'fischer', name: 'Bobby Fischer' },
  { key: 'kasparov', name: 'Garry Kasparov' },
  { key: 'carlsen', name: 'Magnus Carlsen' },
  { key: 'anderssen', name: 'Adolf Anderssen' },
  { key: 'capablanca', name: 'Jose Raul Capablanca' },
  { key: 'tal', name: 'Mikhail Tal' },
  { key: 'botvinnik', name: 'Mikhail Botvinnik' },
  { key: 'caruana', name: 'Fabiano Caruana' },
  { key: 'nimzowitsch', name: 'Aron Nimzowitsch' },
  { key: 'reti', name: 'Richard Reti' },
  { key: 'alekhine', name: 'Alexander Alekhine' },
  { key: 'breyer', name: 'Gyula Breyer' },
  { key: 'bogoljubow', name: 'Efim Bogoljubow' },
  { key: 'larsen', name: 'Bent Larsen' },
  { key: 'petrosian', name: 'Tigran Petrosian' },
  { key: 'bronstein', name: 'David Bronstein' },
  { key: 'blackburne', name: 'Joseph Blackburne' },
  { key: 'bird', name: 'Henry Bird' },
  { key: 'chigorin', name: 'Mikhail Chigorin' },
  { key: 'delabourdonnais', name: 'Louis de La Bourdonnais' },
  { key: 'mcdonnell', name: 'Alexander McDonnell' },
  { key: 'staunton', name: 'Howard Staunton' },
  { key: 'steinitz', name: 'William Steinitz' },
  { key: 'zukertort', name: 'Johannes Zukertort' },
  { key: 'spielmann', name: 'Rudolf Spielmann' },
  { key: 'benko', name: 'Pal Benko' },
  { key: 'smyslov', name: 'Vasily Smyslov' },
  { key: 'spassky', name: 'Boris Spassky' },
  { key: 'keres', name: 'Paul Keres' },
  { key: 'korchnoi', name: 'Viktor Korchnoi' },
  { key: 'giri', name: 'Anish Giri' },
  { key: 'aronian', name: 'Levon Aronian' },
  { key: 'mamedyarov', name: 'Shakhriyar Mamedyarov' },
  { key: 'firouzja', name: 'Alireza Firouzja' },
  { key: 'nakamura', name: 'Hikaru Nakamura' },
  { key: 'vachierlagrave', name: 'Maxime Vachier-Lagrave' },
  { key: 'duda', name: 'Jan-Krzysztof Duda' },
  { key: 'rapport', name: 'Richard Rapport' },
  { key: 'so', name: 'Wesley So' },
  { key: 'gukesh', name: 'Dommaraju Gukesh' },
  { key: 'praggnanandhaa', name: 'Rameshbabu Praggnanandhaa' },
  { key: 'erigaisi', name: 'Arjun Erigaisi' },
  { key: 'abdusattorov', name: 'Nodirbek Abdusattorov' },
  { key: 'keymer', name: 'Vincent Keymer' },
] as const;

export type PlayerKey = typeof PLAYER_CHOICES[number]['key'];
export type DatabaseSourceKey = 'masters' | 'lichess-2000';
export type RecommendationSourceKey = PlayerKey | DatabaseSourceKey;
export type RecommendationPackKey = 'hypermodern' | 'romantic' | 'golden-era' | 'goats' | 'magnus-era' | 'post-magnus';

export interface PlayerChoice {
  key: PlayerKey;
  name: string;
}

export type RecommendationSourceChoice =
  | { key: PlayerKey; name: string; kind: 'player-book' }
  | { key: DatabaseSourceKey; name: string; kind: 'database' };

export interface RecommendationPack {
  key: RecommendationPackKey;
  name: string;
  description: string;
  sources: RecommendationSourceKey[];
}

export const RECOMMENDATION_CHOICES: RecommendationSourceChoice[] = [
  ...PLAYER_CHOICES.map(player => ({ ...player, kind: 'player-book' as const })),
  { key: 'masters', name: 'Masters database', kind: 'database' },
  { key: 'lichess-2000', name: 'Lichess 2000+ games', kind: 'database' },
];

export const RECOMMENDATION_PACKS: RecommendationPack[] = [
  {
    key: 'hypermodern',
    name: 'Hypermodern',
    description: 'Nimzowitsch, Reti, Alekhine, Breyer, Bogoljubow, Larsen, Petrosian, Bronstein, then masters.',
    sources: ['nimzowitsch', 'reti', 'alekhine', 'breyer', 'bogoljubow', 'larsen', 'petrosian', 'bronstein', 'masters'],
  },
  {
    key: 'romantic',
    name: 'Romantic',
    description: 'Morphy, Anderssen, Blackburne, Bird, Chigorin, La Bourdonnais, McDonnell, Staunton, Steinitz, then masters.',
    sources: ['morphy', 'anderssen', 'blackburne', 'bird', 'chigorin', 'delabourdonnais', 'mcdonnell', 'staunton', 'steinitz', 'masters'],
  },
  {
    key: 'golden-era',
    name: 'Golden Era',
    description: 'Tal, Botvinnik, Benko, Petrosian, Smyslov, Spassky, Keres, Bronstein, Korchnoi, then masters.',
    sources: ['tal', 'botvinnik', 'benko', 'petrosian', 'smyslov', 'spassky', 'keres', 'bronstein', 'korchnoi', 'masters'],
  },
  {
    key: 'goats',
    name: 'GOATs',
    description: 'Kasparov, Morphy, Magnus, and Fischer only, then masters.',
    sources: ['kasparov', 'morphy', 'carlsen', 'fischer', 'masters'],
  },
  {
    key: 'magnus-era',
    name: 'Magnus Era',
    description: 'Magnus, Anish, Caruana, Aronian, Mamedyarov, Firouzja, Hikaru, MVL, Duda, Rapport, So, then masters.',
    sources: ['carlsen', 'giri', 'caruana', 'aronian', 'mamedyarov', 'firouzja', 'nakamura', 'vachierlagrave', 'duda', 'rapport', 'so', 'masters'],
  },
  {
    key: 'post-magnus',
    name: 'Post-Magnus',
    description: 'Gukesh, Praggnanandhaa, Erigaisi, Abdusattorov, Keymer, Firouzja, Duda, then masters.',
    sources: ['gukesh', 'praggnanandhaa', 'erigaisi', 'abdusattorov', 'keymer', 'firouzja', 'duda', 'masters'],
  },
];

export interface RecommendationSettings {
  playerPriorities: Record<RecommendationSourceKey, number>;
  playerBookMaxCpLoss: number;
  stealPaulMorphy?: boolean;
}

const DEFAULT_PLAYER_PRIORITIES = {
  ...Object.fromEntries(PLAYER_CHOICES.map(player => [player.key, player.key === 'self' ? 1 : 0])),
  masters: 2,
  'lichess-2000': 3,
} as Record<RecommendationSourceKey, number>;

export const DEFAULT_RECOMMENDATION_SETTINGS: RecommendationSettings = {
  playerBookMaxCpLoss: 75,
  playerPriorities: DEFAULT_PLAYER_PRIORITIES,
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

export function prioritiesFromSources(sources: RecommendationSourceKey[]): RecommendationSettings['playerPriorities'] {
  const next = { ...DEFAULT_PLAYER_PRIORITIES };
  for (const key of Object.keys(next) as RecommendationSourceKey[]) next[key] = 0;
  sources.forEach((key, index) => {
    next[key] = index + 1;
  });
  return next;
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
