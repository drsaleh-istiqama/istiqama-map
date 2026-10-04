/**
 * Geographic scope of a branch (`branches.admin_area_ids`, brief §2.2): a searchable tree of
 * the country's administrative areas (levels 1–3) from the synced `admin_areas` rows — or,
 * when this device has not received them, read once from the server. Only expanded nodes
 * and search hits are rendered, so countries with thousands of wards stay fast.
 * Selecting an area covers everything inside it; its descendants are shown as included.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { pickName, t } from '../i18n';
import { Spinner, useDebounced } from '../ui';
import { fetchAreas, isOnline } from './api';
import {
  areaPath,
  buildAreaTree,
  childrenOf,
  searchAreas,
  selectedAncestor,
  unknownIds,
  type AreaTree,
} from './areaTree';
import { localAreas } from './queries';
import type { AreaNode } from './types';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; areas: AreaNode[]; source: 'local' | 'server' }
  | { kind: 'empty' };

function useCountryAreas(countryId: string): LoadState {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  useEffect(() => {
    if (!countryId) {
      setState({ kind: 'empty' });
      return;
    }
    let alive = true;
    setState({ kind: 'loading' });
    void (async () => {
      let areas: AreaNode[];
      let source: 'local' | 'server' = 'local';
      try {
        areas = await localAreas(countryId);
      } catch {
        areas = [];
      }
      if (areas.length === 0 && isOnline()) {
        try {
          areas = await fetchAreas<AreaNode>(countryId);
          source = 'server';
        } catch {
          areas = [];
        }
      }
      if (alive) setState(areas.length ? { kind: 'ready', areas, source } : { kind: 'empty' });
    })();
    return () => {
      alive = false;
    };
  }, [countryId]);
  return state;
}

function pathText(tree: AreaTree, id: string): string {
  return areaPath(tree, id)
    .map((a) => pickName(a))
    .join(' › ');
}

export function AreaTreePicker({
  countryId,
  value,
  onChange,
  idBase,
  labelledBy,
}: {
  countryId: string;
  value: readonly string[];
  onChange: (ids: string[]) => void;
  idBase: string;
  labelledBy?: string;
}) {
  const state = useCountryAreas(countryId);
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 200);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const selected = useMemo(() => new Set(value), [value]);
  const tree = useMemo(
    () => (state.kind === 'ready' ? buildAreaTree(state.areas, (a) => pickName(a)) : null),
    [state],
  );

  const toggle = (id: string, on: boolean): void => {
    if (on) onChange([...value.filter((v) => v !== id), id]);
    else onChange(value.filter((v) => v !== id));
  };
  const toggleExpanded = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!countryId) return <p class="muted">{t('admin.areasChooseCountry')}</p>;
  if (state.kind === 'loading') return <Spinner />;
  if (state.kind === 'empty' || !tree) {
    return (
      <p class="adm-note" data-testid={`${idBase}-no-areas`}>
        {t('admin.areasNone')}
      </p>
    );
  }

  const hits = debounced.trim() ? searchAreas(tree, debounced) : null;
  const missing = unknownIds(tree, value);

  const renderNode = (area: AreaNode, depth: number) => {
    const kids = childrenOf(tree, area.id);
    const isOpen = expanded.has(area.id);
    const covering = selectedAncestor(tree, area.id, selected);
    const checked = selected.has(area.id) || covering !== null;
    const name = pickName(area);
    return (
      <li key={area.id}>
        <div class="adm-tree__row" style={{ paddingInlineStart: `${depth * 1.25}rem` }}>
          {kids.length > 0 ? (
            <button
              type="button"
              class="icon-btn icon-btn--sm adm-tree__toggle"
              aria-expanded={isOpen ? 'true' : 'false'}
              aria-label={t('admin.showInside', { name })}
              data-testid={`${idBase}-expand`}
              onClick={() => toggleExpanded(area.id)}
            >
              <span aria-hidden="true">{isOpen ? '−' : '+'}</span>
            </button>
          ) : (
            <span class="adm-tree__spacer" aria-hidden="true" />
          )}
          <label class="adm-check adm-tree__label">
            <input
              type="checkbox"
              checked={checked}
              disabled={covering !== null}
              data-testid={`${idBase}-area`}
              data-area-id={area.id}
              onChange={(e) => toggle(area.id, e.currentTarget.checked)}
            />
            <span>{name}</span>
            {covering && <span class="muted adm-tree__note">{t('admin.areaIncluded')}</span>}
          </label>
        </div>
        {isOpen && kids.length > 0 && (
          <ul class="adm-tree__group">{kids.map((k) => renderNode(k, depth + 1))}</ul>
        )}
      </li>
    );
  };

  return (
    <div class="adm-areas" data-testid={idBase}>
      <div class="adm-areas__chips" aria-live="polite">
        {value.length === 0 ? (
          <span class="muted">{t('admin.areasNoneSelected')}</span>
        ) : (
          value.map((id) => (
            <span key={id} class="adm-chip adm-chip--removable" data-testid={`${idBase}-chip`}>
              <span>{tree.byId.has(id) ? pathText(tree, id) : t('admin.areaUnknown')}</span>
              <button
                type="button"
                class="icon-btn icon-btn--sm"
                aria-label={t('admin.removeNamed', {
                  name: tree.byId.has(id) ? pathText(tree, id) : t('admin.areaUnknown'),
                })}
                onClick={() => toggle(id, false)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </span>
          ))
        )}
      </div>
      {missing.length > 0 && (
        <p class="adm-note">{t('admin.areasMissing', { count: missing.length })}</p>
      )}
      <input
        type="search"
        class="control"
        data-testid={`${idBase}-search`}
        aria-label={t('admin.searchAreas')}
        placeholder={t('admin.searchAreas')}
        value={query}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      {hits ? (
        hits.length === 0 ? (
          <p class="muted">{t('admin.areasNoMatch')}</p>
        ) : (
          <ul class="adm-tree adm-tree--hits" aria-labelledby={labelledBy}>
            {hits.map((area) => {
              const covering = selectedAncestor(tree, area.id, selected);
              return (
                <li key={area.id}>
                  <label class="adm-check adm-tree__label">
                    <input
                      type="checkbox"
                      checked={selected.has(area.id) || covering !== null}
                      disabled={covering !== null}
                      data-testid={`${idBase}-hit`}
                      data-area-id={area.id}
                      onChange={(e) => toggle(area.id, e.currentTarget.checked)}
                    />
                    <span>{pathText(tree, area.id)}</span>
                    <span class="muted adm-tree__note">
                      {t('admin.areaLevel', { level: area.level })}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <ul class="adm-tree" aria-labelledby={labelledBy}>
          {childrenOf(tree, null).map((area) => renderNode(area, 0))}
        </ul>
      )}
      {state.source === 'server' && <p class="muted adm-small">{t('admin.areasFromServer')}</p>}
    </div>
  );
}
