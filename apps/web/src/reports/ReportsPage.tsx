/**
 * Reports page (brief §9, docs/contracts/reports-import-export.md §2, §4):
 *
 *   - scope picker: only the scopes the user may read (global / country / branch);
 *   - dashboard of that scope from `dashboard()` — online; the last result of each scope is
 *     kept on the device and shown offline with the time the figures were computed;
 *   - server-side export (CSV / XLSX) with job tracking and download;
 *   - links to the printable reports and to the heat maps of the map view.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { can, me } from '../auth';
import { fmt, locale, pickName, t } from '../i18n';
import { useViewFilters } from '../routes';
import { Button, EmptyState, IconDownload, IconOffline, Spinner } from '../ui';
import { isOnline, reportsApi } from './api';
import { readCachedDashboard, writeCachedDashboard } from './cache';
import { DashboardView } from './Dashboard';
import { reportErrorText } from './errors';
import {
  defaultChoices,
  ExportDialog,
  ExportJobs,
  scopeNames,
  type ExportChoices,
} from './ExportPanel';
import { useFxPlaceholder, useOnline } from './hooks';
import { IconRefresh } from './icons';
import { PrintLinks } from './PrintLinks';
import {
  loadScopeOptions,
  parseScopeKey,
  pickInitialScope,
  printableCountries,
  readTriple,
  type ScopeOption,
} from './scope';
import { parseDashboard, type Dashboard, type ScopeRef } from './types';

interface ViewState {
  key: string | null;
  data: Dashboard | null;
  source: 'live' | 'cache' | null;
  savedAt: number | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: ViewState = {
  key: null,
  data: null,
  source: null,
  savedAt: null,
  loading: false,
  error: null,
};

export function optionLabel(o: ScopeOption): string {
  if (o.type === 'global') return t('reports.scopeGlobal');
  const row = o.country ?? o.branch;
  return row
    ? pickName(row) || (o.branch?.code ?? o.country?.iso2 ?? '')
    : t('reports.scopeUnknown');
}

export default function ReportsPage() {
  const context = me.value;
  const userId = context?.user_id ?? null;
  const epoch = context?.scope_epoch ?? '';
  const read = readTriple(context);
  const readKey = JSON.stringify(read);
  const hideNames = !can.seePeople.value;
  const online = useOnline();
  const fxPlaceholder = useFxPlaceholder();
  const [filters, setFilters] = useViewFilters<{ scope: string }>('reports', { scope: '' });
  const [options, setOptions] = useState<ScopeOption[] | null>(null);
  const [view, setView] = useState<ViewState>(EMPTY);
  const [reloadTick, setReloadTick] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [choices, setChoices] = useState<ExportChoices>(() => defaultChoices(locale.value));

  useEffect(() => {
    let alive = true;
    loadScopeOptions(read)
      .then((list) => alive && setOptions(list))
      .catch(() => alive && setOptions([]));
    return () => {
      alive = false;
    };
  }, [readKey]);

  const selected = options ? pickInitialScope(options, filters.scope || null) : null;
  const scope: ScopeRef | null = selected ? parseScopeKey(selected.key) : null;
  const selectedKey = selected?.key ?? null;

  // Load: the saved copy at once, then the live figures when online.
  useEffect(() => {
    if (!scope || !userId || !selectedKey) return;
    let alive = true;
    const key = selectedKey;
    setView((v) =>
      v.key === key ? { ...v, loading: true, error: null } : { ...EMPTY, key, loading: true },
    );
    void (async () => {
      const cached = await readCachedDashboard(userId, epoch, scope);
      if (!alive) return;
      if (cached) {
        setView((v) =>
          v.key === key && v.source === 'live'
            ? v
            : { ...v, key, data: cached.data, source: 'cache', savedAt: cached.savedAt },
        );
      }
      if (!isOnline()) {
        setView((v) => (v.key === key ? { ...v, loading: false } : v));
        return;
      }
      try {
        const raw = await reportsApi().dashboard(scope);
        if (!alive) return;
        const data = parseDashboard(raw);
        const now = Date.now();
        setView({ key, data, source: 'live', savedAt: now, loading: false, error: null });
        await writeCachedDashboard(userId, epoch, scope, raw, now);
      } catch (e) {
        if (!alive) return;
        setView((v) => (v.key === key ? { ...v, loading: false, error: reportErrorText(e) } : v));
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedKey, userId, epoch, reloadTick]);

  // Back online: refresh what is on screen (not on the first render).
  const [wasOffline, setWasOffline] = useState(!online);
  useEffect(() => {
    if (!online) setWasOffline(true);
    else if (wasOffline) {
      setWasOffline(false);
      setReloadTick((n) => n + 1);
    }
  }, [online]);

  const names = useMemo(() => scopeNames(options ?? []), [options, locale.value]);

  if (!options) {
    return (
      <div class="page reports" data-testid="reports-page">
        <Spinner />
      </div>
    );
  }

  if (options.length === 0 || !selected || !scope) {
    return (
      <div class="page reports" data-testid="reports-page">
        <EmptyState
          title={t('reports.noScopeTitle')}
          message={t('reports.noScopeBody')}
          testId="reports-no-scope"
        />
      </div>
    );
  }

  const groups: Array<{ type: ScopeOption['type']; label: string }> = [
    { type: 'country', label: t('reports.groupCountries') },
    { type: 'branch', label: t('reports.groupBranches') },
  ];
  const data = view.key === selected.key ? view.data : null;
  const refreshedAt = data?.last_refreshed_at ?? null;
  const countries = printableCountries(options);
  const initialCountry =
    scope.type === 'country'
      ? scope.id
      : scope.type === 'branch'
        ? (selected.branch?.country_id ?? null)
        : null;

  return (
    <div class="page reports" data-testid="reports-page">
      <section class="card rhead" aria-label={t('reports.scopeLabel')}>
        <div class="rhead__row">
          <div class="field rhead__scope">
            <label class="field__label" for="reports-scope">
              {t('reports.scopeLabel')}
            </label>
            <select
              id="reports-scope"
              class="control select"
              data-testid="reports-scope"
              value={selected.key}
              onChange={(e) => setFilters({ scope: e.currentTarget.value })}
            >
              {options
                .filter((o) => o.type === 'global')
                .map((o) => (
                  <option key={o.key} value={o.key}>
                    {optionLabel(o)}
                  </option>
                ))}
              {groups.map((g) => {
                const list = options.filter((o) => o.type === g.type);
                return list.length === 0 ? null : (
                  <optgroup key={g.type} label={g.label}>
                    {list.map((o) => (
                      <option key={o.key} value={o.key}>
                        {optionLabel(o)}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </div>
          <div class="rhead__actions">
            <Button
              icon={<IconRefresh />}
              busy={view.loading && online}
              disabled={!online}
              onClick={() => setReloadTick((n) => n + 1)}
              testId="reports-refresh"
            >
              {t('reports.refresh')}
            </Button>
            <Button
              variant="gold"
              icon={<IconDownload size={20} />}
              onClick={() => setExportOpen(true)}
              testId="reports-export"
            >
              {t('reports.export')}
            </Button>
          </div>
        </div>
        <p
          class="rhead__fresh muted"
          role="status"
          data-testid="reports-freshness"
          data-source={view.key === selected.key ? (view.source ?? '') : ''}
          data-refreshed={refreshedAt ?? ''}
        >
          {data && refreshedAt
            ? t('reports.freshness', { date: fmt.dateTime(refreshedAt) })
            : data
              ? t('reports.freshnessUnknown')
              : ''}
          {data && view.source === 'cache' && view.savedAt !== null && (
            <> · {t('reports.savedCopy', { date: fmt.dateTime(new Date(view.savedAt)) })}</>
          )}
        </p>
      </section>

      {!online && (
        <p class="rbanner" role="status" data-testid="reports-offline">
          <IconOffline size={18} />
          <span>{data ? t('reports.offlineCached') : t('reports.offlineNoCache')}</span>
        </p>
      )}

      {view.error && view.key === selected.key && (
        <div class="rbanner rbanner--error" role="alert" data-testid="reports-error">
          <span>{view.error}</span>
          {online && (
            <Button size="sm" onClick={() => setReloadTick((n) => n + 1)} testId="reports-retry">
              {t('reports.retry')}
            </Button>
          )}
        </div>
      )}

      {data ? (
        <DashboardView data={data} hideNames={hideNames} fxPlaceholder={fxPlaceholder} />
      ) : view.loading && online ? (
        <Spinner />
      ) : (
        !online && (
          <EmptyState
            icon={<IconOffline size={40} />}
            title={t('reports.offlineTitle')}
            message={t('reports.offlineNoCache')}
            testId="reports-empty-offline"
          />
        )
      )}

      <PrintLinks countries={countries} initialCountry={initialCountry} />

      <section class="card rcard" aria-labelledby="rs-export" data-testid="reports-exports">
        <h2 id="rs-export" class="rcard__title">
          {t('reports.sectionExport')}
        </h2>
        <p class="rnote">{t('reports.exportIntro')}</p>
        <ExportJobs names={names} />
      </section>

      <ExportDialog
        open={exportOpen}
        scope={scope}
        scopeLabel={optionLabel(selected)}
        choices={choices}
        onChoices={setChoices}
        onClose={() => setExportOpen(false)}
        onStarted={() => setExportOpen(false)}
      />
    </div>
  );
}
