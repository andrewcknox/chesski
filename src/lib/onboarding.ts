import type { Color, Repertoire } from '../types';
import { addMovesToRepertoire, createRepertoire, ensureDefaultMainRepertoires, getMeta, listRepertoires, setMeta } from './storage';
import { findOpening } from './openings';

const META_FIRST_RUN_ONBOARDING = 'first_run_onboarding_v1';

export type FirstRunOnboardingState = 'pending' | 'done';

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

export async function completeFirstRunOnboarding(): Promise<void> {
  await setMeta(META_FIRST_RUN_ONBOARDING, 'done');
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
