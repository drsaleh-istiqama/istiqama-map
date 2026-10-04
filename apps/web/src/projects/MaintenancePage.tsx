import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { listOpenMaintenance, type MaintenanceCursor, type MaintenanceListItem } from '../db';
import { fmt, pickName, t } from '../i18n';
import { navigate, useViewFilters } from '../routes';
import { syncStatus } from '../sync';
import { EmptyState, Spinner, useMediaQuery, VirtualList } from '../ui';
import { TypeIcon } from './labels';
import { MaintenanceStateBadge, PriorityBadge } from './MaintenanceSection';
import { currentActor } from './permissions';
import { placeOf } from './ProjectCard';
import {
  activeFilterCount,
  ProjectFilters,
  ResetFiltersButton,
  toProjectFilter,
  type ListFilters,
} from './ProjectFilters';
import { PAGE_SIZE } from './ProjectList';
import './projects.css';

export const MAINTENANCE_ROW_HEIGHT = 92;

function MaintenanceRow({ item }: { item: MaintenanceListItem }) {
  const { entry, project } = item;
  const place = project ? placeOf(project) : '';
  const cost =
    entry.estimated_cost !== null
      ? entry.currency
        ? fmt.currency(entry.estimated_cost, entry.currency)
        : fmt.number(entry.estimated_cost)
      : '';
  return (
    <div
      class="mrow"
      data-testid="maintenance-row"
      data-id={entry.id}
      data-priority={entry.priority}
    >
      <div class="mrow__head">
        <PriorityBadge priority={entry.priority} />
        <MaintenanceStateBadge state={entry.state} />
        {project && <TypeIcon type={project.type} size={18} />}
        <bdi class="mrow__title">
          {project ? pickName(project) : t('projects.projectNotOnDevice')}
        </bdi>
      </div>
      <div class="mrow__text" dir="auto">
        {entry.description}
      </div>
      <div class="mrow__meta">
        {[fmt.date(entry.reported_on), place, cost].filter((s) => s !== '').join(' · ')}
      </div>
    </div>
  );
}

/**
 * Open maintenance across the projects on this device (route `/maintenance`): most urgent
 * first, then the newest; keyset pages of 50; filters remembered under the view key
 * `maintenance`.
 */
export default function MaintenancePage() {
  const [filters, setFilters, resetFilters] = useViewFilters<ListFilters>('maintenance', {});
  const actor = currentActor();
  const wide = useMediaQuery('(min-width: 900px)');
  const [panelOpen, setPanelOpen] = useState(wide);
  const [rows, setRows] = useState<MaintenanceListItem[]>([]);
  const [next, setNext] = useState<MaintenanceCursor | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const loadingMore = useRef(false);
  const dbFilter = useMemo(() => toProjectFilter({ ...filters, q: undefined }), [filters]);
  const key = JSON.stringify(dbFilter);
  const { lastSyncAt, pendingOps } = syncStatus.value;

  useEffect(() => {
    const mine = ++generation.current;
    loadingMore.current = false;
    setLoading(true);
    listOpenMaintenance(dbFilter, null, PAGE_SIZE)
      .then((page) => {
        if (generation.current !== mine) return;
        setRows(page.rows);
        setNext(page.next);
        setTotal(page.total);
        setLoading(false);
      })
      .catch(() => {
        if (generation.current === mine) setLoading(false);
      });
  }, [key, lastSyncAt, pendingOps]);

  const loadMore = useCallback(() => {
    if (!next || loadingMore.current) return;
    loadingMore.current = true;
    const mine = generation.current;
    listOpenMaintenance(dbFilter, next, PAGE_SIZE)
      .then((page) => {
        if (generation.current !== mine) return;
        setRows((r) => {
          const seen = new Set(r.map((x) => x.entry.id));
          return [...r, ...page.rows.filter((x) => !seen.has(x.entry.id))];
        });
        setNext(page.next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation.current === mine) loadingMore.current = false;
      });
  }, [next, key]);

  const activeCount = activeFilterCount(filters);
  const moreCount = activeCount - (filters.type ? 1 : 0) - (filters.status ? 1 : 0);

  return (
    <div class="ppage ppage--fill" data-testid="maintenance-page">
      <div class="plist">
        <div class="plist__bar">
          <p class="plist__search ppage__intro" style={{ margin: 0 }}>
            {t('projects.maintenanceIntro')}
          </p>
          <button
            type="button"
            class="btn btn--secondary plist__toggle"
            aria-expanded={panelOpen ? 'true' : 'false'}
            aria-controls="maintenance-filters"
            data-testid="filters-toggle"
            onClick={() => setPanelOpen((o) => !o)}
          >
            <span class="btn__label">
              {moreCount > 0
                ? t('projects.filtersActive', { count: fmt.number(moreCount) })
                : t('projects.filters')}
            </span>
          </button>
        </div>
        <ProjectFilters
          idPrefix="maintenance"
          group="quick"
          filters={filters}
          showMine={actor.write}
          onChange={(patch) => setFilters(patch)}
        />
        <div id="maintenance-filters" class="pfilters" hidden={!panelOpen}>
          <ProjectFilters
            group="more"
            idPrefix="maintenance"
            filters={filters}
            showMine={actor.write}
            fields={{ recordState: false, incomplete: false, openMaintenance: false }}
            onChange={(patch) => setFilters(patch)}
          />
        </div>
        <div class="plist__counter">
          <span data-testid="maintenance-counter" role="status" aria-live="polite">
            {total === null
              ? t('projects.counting')
              : t('projects.maintenanceCount', { count: fmt.number(total) })}
          </span>
          <ResetFiltersButton disabled={activeCount === 0} onReset={resetFilters} />
        </div>
        <div class="plist__rows">
          {loading && rows.length === 0 ? (
            <Spinner block />
          ) : rows.length === 0 ? (
            <EmptyState
              testId="maintenance-empty"
              title={
                activeCount > 0
                  ? t('projects.maintenanceEmptyFiltered')
                  : t('projects.maintenanceEmpty')
              }
            />
          ) : (
            <VirtualList
              items={rows}
              rowHeight={MAINTENANCE_ROW_HEIGHT}
              rowKey={(item) => item.entry.id}
              renderRow={(item) => <MaintenanceRow item={item} />}
              onEndReached={next ? loadMore : undefined}
              onActivate={(index) => {
                const item = rows[index];
                if (item) navigate(`/projects/${item.entry.project_id}`);
              }}
              label={t('projects.maintenanceListLabel')}
              testId="maintenance-rows"
            />
          )}
        </div>
      </div>
    </div>
  );
}
