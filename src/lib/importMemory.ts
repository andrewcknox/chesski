import type { Color } from '../types';
import type { CuratedOpening } from './openings';
import type { ImportDecision, ImportDraft, ImportSource, ImportSpeed } from './gameImport';
import { getMeta, setMeta } from './storage';

const META_IMPORT_MEMORY = 'import_memory_v1';

export interface ImportMemoryEntry {
  key: string;
  sourceOpeningKey: string;
  openingName: string;
  color: Color;
  username: string;
  source: ImportSource;
  speeds: ImportSpeed[];
  gameCount: number;
  matchedGameIds: string[];
  cpLossThreshold: number;
  lines: string[][];
  decisions: ImportDecision[];
  updatedAt: string;
}

type ImportMemoryByKey = Record<string, ImportMemoryEntry>;

export function importMemoryKeyForOpening(opening: Pick<CuratedOpening, 'key' | 'color'>): string {
  return `${opening.color}-${baseOpeningKey(opening.key)}`;
}

export async function rememberImportDraft(draft: ImportDraft, source: ImportSource): Promise<ImportMemoryEntry[]> {
  const existing = (await getMeta<ImportMemoryByKey>(META_IMPORT_MEMORY)) ?? {};
  const now = new Date().toISOString();
  const saved: ImportMemoryEntry[] = [];

  for (const root of draft.roots) {
    if (root.lines.length === 0) continue;
    const key = importMemoryKeyForOpening(root.opening);
    const entry: ImportMemoryEntry = {
      key,
      sourceOpeningKey: root.opening.key,
      openingName: root.opening.name,
      color: root.opening.color,
      username: draft.username,
      source,
      speeds: draft.speeds,
      gameCount: root.gameCount,
      matchedGameIds: root.matchedGameIds,
      cpLossThreshold: draft.cpLossThreshold,
      lines: root.lines,
      decisions: root.decisions,
      updatedAt: now,
    };
    existing[key] = entry;
    saved.push(entry);
  }

  await setMeta(META_IMPORT_MEMORY, existing);
  return saved;
}

export async function getImportMemoryForOpening(opening: Pick<CuratedOpening, 'key' | 'color'>): Promise<ImportMemoryEntry | null> {
  const memory = (await getMeta<ImportMemoryByKey>(META_IMPORT_MEMORY)) ?? {};
  return memory[importMemoryKeyForOpening(opening)] ?? null;
}

function baseOpeningKey(key: string): string {
  const withoutMirror = key.replace(/-as-[wb]$/, '');
  return withoutMirror.replace(/-[wb]$/, '');
}
