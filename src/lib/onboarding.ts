import type { Color, Repertoire } from '../types';
import { addMovesToRepertoire, createRepertoire, ensureDefaultMainRepertoires, getMeta, listRepertoires, setMeta } from './storage';
import { findOpening } from './openings';
import {
  RECOMMENDATION_PACKS,
  setAlgorithmPreferences,
  type AlgorithmPreferences,
  type AlgorithmScope,
  type RecommendationSourceKey,
} from './recommendationSettings';

const META_FIRST_RUN_ONBOARDING = 'first_run_onboarding_v1';

export type FirstRunOnboardingState = 'pending' | 'done';
export type OnboardingSourcePresetKey = 'balanced' | 'romantic' | 'hypermodern' | 'golden-era' | 'masters' | 'default';

export interface OnboardingSourcePreset {
  key: OnboardingSourcePresetKey;
  name: string;
  description: string;
}

export const ONBOARDING_SOURCE_PRESETS: OnboardingSourcePreset[] = [
  { key: 'balanced', name: 'Balanced', description: 'Use your games first, then strong databases.' },
  { key: 'romantic', name: 'Romantic / attacking', description: 'Favor sharp attacking games and classic initiative.' },
  { key: 'hypermodern', name: 'Hypermodern', description: 'Favor flexible piece play and modern structures.' },
  { key: 'golden-era', name: 'Classical / Golden Era', description: 'Favor clear classical plans from great champions.' },
  { key: 'masters', name: 'Masters database', description: 'Use the master game database first.' },
  { key: 'default', name: 'Customize later', description: 'Keep Chesski defaults for now.' },
];

const STARTER_OPENINGS = [
  { key: 'london-w', color: 'w' as const },
  { key: 'caro-kann-b', color: 'b' as const },
  { key: 'qgd-w-as-b', color: 'b' as const },
];

export async function markFirstRunOnboardingPending(): Promise<void> {
  const current = await getMeta<FirstRunOnboardingState>(META_FIRST_RUN_ONBOARDING);
  if (current !== 'done') await setMeta(META_FIRST_RUN_ONBOARDING, 'pending');
}

export async function getFirstRunOnboardingState(): Promise<FirstRunOnboardingState | undefined> {
  return getMeta<FirstRunOnboardingState>(META_FIRST_RUN_ONBOARDING);
}

export async function setFirstRunOnboardingState(state: FirstRunOnboardingState): Promise<void> {
  await setMeta(META_FIRST_RUN_ONBOARDING, state);
}

export async function completeFirstRunOnboarding(): Promise<void> {
  await setFirstRunOnboardingState('done');
}

export async function restartFirstRunOnboarding(): Promise<void> {
  await ensureDefaultMainRepertoires();
  await setMeta(META_FIRST_RUN_ONBOARDING, 'pending');
}

export async function applyOnboardingSourcePreset(scope: AlgorithmScope, presetKey: OnboardingSourcePresetKey): Promise<void> {
  if (presetKey === 'default') return;
  const preferences = onboardingPresetPreferences(presetKey);
  await setAlgorithmPreferences(scope, preferences);
}

export async function addStarterOpeningSet(): Promise<{ activeRepertoireId: string | null; addedEdges: number; reusedEdges: number }> {
  await ensureDefaultMainRepertoires();
  const whiteRep = await ensureMainRepertoire('w', 'White Main Repertoire');
  const blackRep = await ensureMainRepertoire('b', 'Black Main Repertoire');
  const repsByColor: Record<Color, Repertoire> = { w: whiteRep, b: blackRep };
  let addedEdges = 0;
  let reusedEdges = 0;

  for (const starter of STARTER_OPENINGS) {
    const opening = findOpening(starter.key);
    if (!opening) throw new Error(`Starter opening ${starter.key} is not available.`);
    const target = repsByColor[starter.color];
    const result = await addMovesToRepertoire(target, opening.moves);
    addedEdges += result.addedEdges;
    reusedEdges += result.reusedEdges;
  }

  await completeFirstRunOnboarding();
  return { activeRepertoireId: whiteRep.id, addedEdges, reusedEdges };
}

async function ensureMainRepertoire(color: Color, name: string): Promise<Repertoire> {
  const existing = (await listRepertoires()).find(rep => rep.color === color && (rep.projectKind ?? 'standard') !== 'siloed');
  if (existing) return existing;
  return createRepertoire({ name, color, projectKind: 'standard' });
}

function onboardingPresetPreferences(presetKey: Exclude<OnboardingSourcePresetKey, 'default'>): AlgorithmPreferences {
  if (presetKey === 'balanced') {
    return {
      items: sources(['self', 'masters', 'lichess-2000']),
    };
  }
  if (presetKey === 'masters') {
    return {
      items: sources(['masters', 'lichess-2000']),
    };
  }

  const packKey = presetKey === 'golden-era' ? 'golden-era' : presetKey;
  const pack = RECOMMENDATION_PACKS.find(item => item.key === packKey);
  return {
    items: pack ? [{
      id: `pack:${pack.key}:onboarding`,
      type: 'pack',
      packKey: pack.key,
      sourceKeys: pack.sources,
      expanded: false,
      enabled: true,
    }] : sources(['masters']),
  };
}

function sources(sourceKeys: RecommendationSourceKey[]): AlgorithmPreferences['items'] {
  return sourceKeys.map(sourceKey => ({
    id: `source:${sourceKey}`,
    type: 'source' as const,
    sourceKey,
    enabled: true,
  }));
}
