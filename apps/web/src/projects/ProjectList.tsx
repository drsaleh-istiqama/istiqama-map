import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { listProjects, type ListCursor, type ProjectFilter, type ProjectListItem } from '../db';
import { fmt, t } from '../i18n';
import { navigate, useViewFilters } from '../routes';
import { syncStatus } from '../sync';
import { EmptyState, Spinner, useDebounced, VirtualList } from '../ui';
import { currentActor } from './permissions';
import { PROJECT_ROW_HEIGHT, ProjectCard } from './ProjectCard';
import {
  activeFilterCount,
  ProjectFilters,
  ResetFiltersButton,
  toProjectFilter,
  type ListFilters,
} from './ProjectFilters';
import { countAllProjects } from './queries';
import { SEARCH_DEBOUNCE_MS, useProjectSearch } from './search';
import { SearchHits } from './SearchHits';
import './projects.css';

/** Keyset page size of the register (brief §5). */
export const PAGE_SIZE = 50;

export interface ProjectListProps {
  /** Key under which this view remembers its filters (`projects`, `map`, …). */
  viewKey?: string;
  /** Row activation; default: open the details page. */
  onSelect?: (id: string) => void;
  /** Called with the database filter whenever it changes (the map follows the list). */
  onFilterChange?: (filter: ProjectFilter) => void;
  /** Filters panel open at first render (closed by default on phones). */
  filtersOpen?: boolean;
  class?: string;
}

interface ListState {
  rows: ProjectListItem[];
  next: ListCursor | null;
  /** Rows matching the filter (null while the first page loads). */
  total: number | null;
  loading: boolean;
  error: boolean;
}

const INITIAL: ListState = { rows: [], next: null, total: null, loading: true, error: false };

/** Appends a page, never twice the same id (a defensive guard; keyset pages do not overlap). */
function appendUnique(rows: ProjectListItem[], page: ProjectListItem[]): ProjectListItem[] {
  const seen = new Set(rows.map((r) => r.id));
  const out = rows.slice();
  for (const r of page) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

/**
 * The project register (reusable: the map page embeds it). Virtualised list over keyset pages
 * of 50 from the device; search box with 250 ms debounce (device + server search); filters
 * remembered per view; "visible of total" counter; reset button.
 */
export function ProjectList({
  viewKey = 'projects',
  onSelect,
  onFilterChange,
  filtersOpen,
  class: extra,
}: ProjectListProps) {
  const [filters, setFilters, resetFilters] = useViewFilters<ListFilters>(viewKey, {});
  const actor = currentActor();
  const [panelOpen, setPanelOpen] = useState(filtersOpen ?? false);
  const [state, setState] = useState<ListState>(INITIAL);
  const [allCount, setAllCount] = useState<number | null>(null);
  const generation = useRef(0);
  const loadingMore = useRef(false);
  const rowsRef = useRef<ProjectListItem[]>([]);
  rowsRef.current = state.rows;

  const query = filters.q ?? '';
  const debouncedQ = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const dbFilter = useMemo(() => toProjectFilter(filters, debouncedQ), [filters, debouncedQ]);
  const filterKey = JSON.stringify(dbFilter);
  const search = useProjectSearch(query, actor.seePeople);

  useEffect(() => {
    onFilterChange?.(dbFilter);
  }, [filterKey]);

  /** First page of the current filter (replaces everything). */
  useEffect(() => {
    const mine = ++generation.current;
    loadingMore.current = false;
    setState((s) => ({ ...s, loading: true, error: false }));
    listProjects(dbFilter, null, PAGE_SIZE)
      .then((page) => {
        if (generation.current !== mine) return;
        setState({
          rows: page.rows,
          next: page.next,
          total: page.total,
          loading: false,
          error: false,
        });
      })
      .catch(() => {
        if (generation.current === mine) setState({ ...INITIAL, loading: false, error: true });
      });
    countAllProjects()
      .then((n) => {
        if (generation.current === mine) setAllCount(n);
      })
      .catch(() => undefined);
  }, [filterKey]);

  /** Next keyset page, when the user nears the end of what is loaded. */
  const loadMore = useCallback(() => {
    const cursor = state.next;
    if (!cursor || loadingMore.current) return;
    loadingMore.current = true;
    const mine = generation.current;
    listProjects(dbFilter, cursor, PAGE_SIZE)
      .then((page) => {
        if (generation.current !== mine) return;
        setState((s) => ({ ...s, rows: appendUnique(s.rows, page.rows), next: page.next }));
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation.current === mine) loadingMore.current = false;
      });
  }, [state.next, filterKey]);

  /**
   * After a sync cycle the stored rows may have changed: reload as many pages as are loaded,
   * then swap them in at once (the scroll position stays).
   */
  const lastSyncAt = syncStatus.value.lastSyncAt;
  const firstSync = useRef(lastSyncAt);
  useEffect(() => {
    if (lastSyncAt === firstSync.current) return;
    firstSync.current = lastSyncAt;
    const mine = ++generation.current;
    const wanted = Math.max(PAGE_SIZE, rowsRef.current.length);
    void (async () => {
      let rows: ProjectListItem[] = [];
      let next: ListCursor | null = null;
      let total = 0;
      do {
        const page = await listProjects(dbFilter, next, PAGE_SIZE);
        if (generation.current !== mine) return;
        if (next === null) total = page.total;
        rows = appendUnique(rows, page.rows);
        next = page.next;
      } while (next && rows.length < wanted);
      setState({ rows, next, total, loading: false, error: false });
      setAllCount(await countAllProjects());
    })().catch(() => undefined);
  }, [lastSyncAt]);

  const select = (id: string): void => (onSelect ? onSelect(id) : navigate(`/projects/${id}`));
  const activeCount = activeFilterCount(filters);
  const moreCount = activeCount - (filters.type ? 1 : 0) - (filters.status ? 1 : 0);
  const anyFilter = activeCount > 0 || query.trim() !== '';
  const searchId = `${viewKey}-search`;
  const panelId = `${viewKey}-filters`;

  return (
    <div class={extra ? `plist ${extra}` : 'plist'} data-testid="project-list">
      <div class="plist__bar">
        <div class="plist__search">
          <label class="sr-only" for={searchId}>
            {t('projects.searchLabel')}
          </label>
          <input
            id={searchId}
            type="search"
            class="control"
            data-testid="search-input"
            placeholder={t('projects.searchPlaceholder')}
            autocomplete="off"
            enterkeyhint="search"
            value={query}
            onInput={(event) => setFilters({ q: event.currentTarget.value })}
          />
        </div>
        <button
          type="button"
          class="btn btn--secondary plist__toggle"
          aria-expanded={panelOpen ? 'true' : 'false'}
          aria-controls={panelId}
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
        idPrefix={viewKey}
        group="quick"
        filters={filters}
        showMine={actor.write}
        onChange={(patch) => setFilters(patch)}
      />

      <div id={panelId} class="pfilters" hidden={!panelOpen}>
        <ProjectFilters
          idPrefix={viewKey}
          group="more"
          filters={filters}
          showMine={actor.write}
          onChange={(patch) => setFilters(patch)}
        />
      </div>

      <div class="plist__counter">
        <span data-testid="projects-counter" role="status" aria-live="polite">
          {state.total === null
            ? t('projects.counting')
            : t('projects.counter', {
                visible: fmt.number(state.total),
                total: fmt.number(allCount ?? state.total),
              })}
        </span>
        <ResetFiltersButton disabled={!anyFilter} onReset={resetFilters} />
      </div>

      <SearchHits state={search} onLocality={(name) => setFilters({ q: name })} />

      <div class="plist__rows">
        {state.loading && state.rows.length === 0 ? (
          <Spinner block />
        ) : state.error ? (
          <EmptyState testId="projects-error" title={t('projects.loadError')} />
        ) : state.rows.length === 0 ? (
          <EmptyState
            testId="projects-empty"
            title={anyFilter ? t('projects.emptyFiltered') : t('projects.empty')}
            message={anyFilter ? t('projects.emptyFilteredHint') : t('projects.emptyHint')}
          />
        ) : (
          <VirtualList
            items={state.rows}
            rowHeight={PROJECT_ROW_HEIGHT}
            rowKey={(item) => item.id}
            renderRow={(item) => <ProjectCard item={item} />}
            onEndReached={state.next ? loadMore : undefined}
            onActivate={(index) => {
              const item = state.rows[index];
              if (item) select(item.id);
            }}
            label={t('projects.listLabel')}
            testId="project-rows"
          />
        )}
      </div>
    </div>
  );
}

export default ProjectList;
