import { useEffect, useMemo, useState } from 'react';
import {
  RECOMMENDATION_CHOICES,
  RECOMMENDATION_PACKS,
  clearAlgorithmPreferences,
  extractedSourcesForPack,
  flattenAlgorithmSourceOrder,
  getAlgorithmPreferences,
  getResolvedAlgorithmPreferences,
  setAlgorithmPreferences,
  type AlgorithmPreferenceItem,
  type AlgorithmPreferences,
  type AlgorithmScope,
  type RecommendationPackKey,
  type RecommendationSourceKey,
} from '../lib/recommendationSettings';
import type { Repertoire } from '../types';

interface AlgorithmModeProps {
  scope: AlgorithmScope;
  title: string;
  parentTitle?: string;
  repertoires: Repertoire[];
  onBack: () => void;
}

export function AlgorithmMode({ scope, title, parentTitle, repertoires, onBack }: AlgorithmModeProps) {
  const [preferences, setPreferences] = useState<AlgorithmPreferences | null>(null);
  const [inherited, setInherited] = useState<AlgorithmScope | null>(null);
  const [ownOverride, setOwnOverride] = useState(false);
  const [addSourceKey, setAddSourceKey] = useState<RecommendationSourceKey>('self');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [own, resolved] = await Promise.all([
        scope.kind === 'global' ? getAlgorithmPreferences(scope) : getAlgorithmPreferences(scope),
        getResolvedAlgorithmPreferences(scope),
      ]);
      if (cancelled) return;
      setPreferences(own ?? resolved.preferences);
      setOwnOverride(scope.kind === 'global' || !!own);
      setInherited(own ? null : resolved.inheritedFrom);
    })();
    return () => { cancelled = true; };
  }, [scope]);

  const sourceNames = useMemo(
    () => new Map(RECOMMENDATION_CHOICES.map(source => [source.key, source.name] as const)),
    []
  );
  const packNames = useMemo(
    () => new Map(RECOMMENDATION_PACKS.map(pack => [pack.key, pack.name] as const)),
    []
  );

  async function commit(next: AlgorithmPreferences) {
    setPreferences(next);
    setOwnOverride(true);
    setInherited(null);
    await setAlgorithmPreferences(scope, next);
    setStatus('Saved');
  }

  async function customizeHere() {
    if (!preferences) return;
    await commit(preferences);
  }

  async function resetToInherited() {
    if (scope.kind === 'global') return;
    await clearAlgorithmPreferences(scope);
    const resolved = await getResolvedAlgorithmPreferences(scope);
    setPreferences(resolved.preferences);
    setOwnOverride(false);
    setInherited(resolved.inheritedFrom);
    setStatus('Now inheriting');
  }

  function updateItems(updater: (items: AlgorithmPreferenceItem[]) => AlgorithmPreferenceItem[]) {
    if (!preferences || !ownOverride) return;
    void commit({ ...preferences, items: updater(preferences.items) });
  }

  function moveItem(index: number, delta: -1 | 1) {
    updateItems(items => {
      const next = [...items];
      const target = index + delta;
      if (target < 0 || target >= next.length) return next;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function setItemEnabled(index: number, enabled: boolean) {
    updateItems(items => items.map((item, i) => i === index ? { ...item, enabled } : item));
  }

  function removeItem(index: number) {
    updateItems(items => items.filter((_, i) => i !== index));
  }

  function addSource() {
    updateItems(items => [
      ...items.filter(item => item.type !== 'source' || item.sourceKey !== addSourceKey),
      { id: `source:${addSourceKey}`, type: 'source', sourceKey: addSourceKey, enabled: true },
    ]);
  }

  function addPack(packKey: RecommendationPackKey) {
    const pack = RECOMMENDATION_PACKS.find(candidate => candidate.key === packKey);
    if (!pack) return;
    updateItems(items => [
      ...items,
      {
        id: `pack:${pack.key}:${Date.now().toString(36)}`,
        type: 'pack',
        packKey: pack.key,
        sourceKeys: pack.sources,
        expanded: true,
        enabled: true,
      },
    ]);
  }

  function togglePackExpanded(index: number) {
    updateItems(items => items.map((item, i) => (
      i === index && item.type === 'pack' ? { ...item, expanded: !item.expanded } : item
    )));
  }

  function movePackSource(index: number, sourceIndex: number, delta: -1 | 1) {
    updateItems(items => items.map((item, i) => {
      if (i !== index || item.type !== 'pack') return item;
      const target = sourceIndex + delta;
      if (target < 0 || target >= item.sourceKeys.length) return item;
      const sourceKeys = [...item.sourceKeys];
      [sourceKeys[sourceIndex], sourceKeys[target]] = [sourceKeys[target], sourceKeys[sourceIndex]];
      return { ...item, sourceKeys };
    }));
  }

  function extractSource(index: number, sourceKey: RecommendationSourceKey) {
    updateItems(items => {
      const withoutExisting = items.filter(item => item.type !== 'source' || item.sourceKey !== sourceKey);
      withoutExisting.splice(index, 0, { id: `source:${sourceKey}`, type: 'source', sourceKey, enabled: true });
      return withoutExisting;
    });
  }

  if (!preferences) return null;

  const flattened = flattenAlgorithmSourceOrder(preferences);
  const canEdit = ownOverride;
  const inheritedLabel = inherited ? scopeLabel(inherited, repertoires) : null;

  return (
    <div className="algorithm-mode">
      <div className="row subview-back-row">
        <button onClick={onBack}>Back</button>
      </div>

      <div className="panel algorithm-scope-panel">
        <div>
          <div className="eyebrow">Algorithm</div>
          <h2>{title.replace(/^Algorithm: /, '')}</h2>
          {parentTitle && <div className="muted small">{parentTitle}</div>}
          {inheritedLabel && !ownOverride && (
            <div className="algorithm-inherited-note">
              Inheriting from {inheritedLabel}.
            </div>
          )}
        </div>
        <div className="row algorithm-scope-actions">
          {!canEdit && <button className="primary" onClick={() => void customizeHere()}>Customize here</button>}
          {scope.kind !== 'global' && canEdit && <button onClick={() => void resetToInherited()}>Inherit from parent</button>}
          {status && <span className="muted small">{status}</span>}
        </div>
      </div>

      <div className="panel">
        <h3>Source priority</h3>
        <div className="settings-copy muted small">
          Chesski checks enabled items from top to bottom. Players pulled out as individual sources are skipped inside any pack below.
        </div>

        <div className="settings-pack-grid">
          {RECOMMENDATION_PACKS.map(pack => (
            <button key={pack.key} className="settings-pack-card" disabled={!canEdit} onClick={() => addPack(pack.key)}>
              <strong>{pack.name}</strong>
              <span>{pack.description}</span>
            </button>
          ))}
        </div>

        <div className="row algorithm-add-source">
          <select value={addSourceKey} disabled={!canEdit} onChange={e => setAddSourceKey(e.target.value as RecommendationSourceKey)}>
            {RECOMMENDATION_CHOICES.map(source => (
              <option key={source.key} value={source.key}>{source.name}</option>
            ))}
          </select>
          <button disabled={!canEdit} onClick={addSource}>Add individual source</button>
        </div>

        <div className="algorithm-priority-list">
          {preferences.items.length === 0 ? (
            <div className="settings-empty-drop">No enabled sources yet. Stockfish remains as the final fallback.</div>
          ) : preferences.items.map((item, index) => item.type === 'source' ? (
            <div key={item.id} className={'settings-player-row algorithm-source-row' + (!item.enabled ? ' inactive' : '')}>
              <span className="settings-player-rank">{index + 1}</span>
              <span className="settings-player-name">{sourceNames.get(item.sourceKey) ?? item.sourceKey}</span>
              <AlgorithmRowControls
                canEdit={canEdit}
                index={index}
                lastIndex={preferences.items.length - 1}
                enabled={item.enabled}
                onMove={moveItem}
                onEnabled={setItemEnabled}
                onRemove={removeItem}
              />
            </div>
          ) : (
            <div key={item.id} className={'algorithm-pack-row' + (!item.enabled ? ' inactive' : '')}>
              <div className="settings-player-row">
                <span className="settings-player-rank">{index + 1}</span>
                <button className="algorithm-pack-toggle" disabled={!canEdit} onClick={() => togglePackExpanded(index)}>
                  {item.expanded ? '-' : '+'}
                </button>
                <span className="settings-player-name">{packNames.get(item.packKey) ?? item.packKey}</span>
                <AlgorithmRowControls
                  canEdit={canEdit}
                  index={index}
                  lastIndex={preferences.items.length - 1}
                  enabled={item.enabled}
                  onMove={moveItem}
                  onEnabled={setItemEnabled}
                  onRemove={removeItem}
                />
              </div>
              <PackDetails
                item={item}
                preferences={preferences}
                expanded={!!item.expanded}
                sourceNames={sourceNames}
                canEdit={canEdit}
                index={index}
                onMovePackSource={movePackSource}
                onExtractSource={extractSource}
              />
            </div>
          ))}
          <div className="settings-fallback-stack">
            <div className="settings-fallback-row stockfish">Stockfish</div>
          </div>
        </div>
      </div>

      <div className="panel algorithm-effective-panel">
        <h3>Effective order</h3>
        <div className="muted small">
          {flattened.length > 0
            ? flattened.map(sourceKey => sourceNames.get(sourceKey) ?? sourceKey).join(' -> ')
            : 'Stockfish only'}
        </div>
      </div>
    </div>
  );
}

function PackDetails({ item, preferences, expanded, sourceNames, canEdit, index, onMovePackSource, onExtractSource }: {
  item: Extract<AlgorithmPreferenceItem, { type: 'pack' }>;
  preferences: AlgorithmPreferences;
  expanded: boolean;
  sourceNames: Map<RecommendationSourceKey, string>;
  canEdit: boolean;
  index: number;
  onMovePackSource: (index: number, sourceIndex: number, delta: -1 | 1) => void;
  onExtractSource: (index: number, sourceKey: RecommendationSourceKey) => void;
}) {
  const extracted = extractedSourcesForPack(preferences, item);
  const included = item.sourceKeys.filter(sourceKey => !extracted.includes(sourceKey));
  return (
    <div className="algorithm-pack-details">
      <div className="muted small">
        includes: {included.length > 0 ? included.map(sourceKey => sourceNames.get(sourceKey) ?? sourceKey).join(' -> ') : 'none'}
      </div>
      {extracted.length > 0 && (
        <div className="muted small">
          excludes: {extracted.map(sourceKey => sourceNames.get(sourceKey) ?? sourceKey).join(', ')}
        </div>
      )}
      {expanded && (
        <div className="algorithm-pack-source-list">
          {item.sourceKeys.map((sourceKey, sourceIndex) => (
            <div key={sourceKey} className={extracted.includes(sourceKey) ? 'algorithm-pack-source extracted' : 'algorithm-pack-source'}>
              <span>{sourceNames.get(sourceKey) ?? sourceKey}</span>
              <div className="row algorithm-mini-actions">
                <button disabled={!canEdit || sourceIndex === 0} onClick={() => onMovePackSource(index, sourceIndex, -1)}>Up</button>
                <button disabled={!canEdit || sourceIndex === item.sourceKeys.length - 1} onClick={() => onMovePackSource(index, sourceIndex, 1)}>Down</button>
                <button disabled={!canEdit} onClick={() => onExtractSource(index, sourceKey)}>Pull out</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AlgorithmRowControls({ canEdit, index, lastIndex, enabled, onMove, onEnabled, onRemove }: {
  canEdit: boolean;
  index: number;
  lastIndex: number;
  enabled: boolean;
  onMove: (index: number, delta: -1 | 1) => void;
  onEnabled: (index: number, enabled: boolean) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="row algorithm-row-actions">
      <button disabled={!canEdit || index === 0} onClick={() => onMove(index, -1)}>Up</button>
      <button disabled={!canEdit || index === lastIndex} onClick={() => onMove(index, 1)}>Down</button>
      <label className="algorithm-enabled-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canEdit}
          onChange={e => onEnabled(index, e.target.checked)}
        />
        <span>Use</span>
      </label>
      <button disabled={!canEdit} onClick={() => onRemove(index)}>Remove</button>
    </div>
  );
}

function scopeLabel(scope: AlgorithmScope, repertoires: Repertoire[]): string {
  if (scope.kind === 'global') return 'global defaults';
  const rep = repertoires.find(candidate => candidate.id === scope.repertoireId);
  return rep?.name ?? 'parent repertoire';
}
