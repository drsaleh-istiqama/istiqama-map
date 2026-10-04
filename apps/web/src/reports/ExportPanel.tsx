/**
 * Export (brief §9.3): the dialog that starts a server-side export and the list of the user's
 * recent export jobs with their live state and download links.
 */
import { useEffect, useState } from 'preact/hooks';
import { can } from '../auth';
import { fmt, pickName, t, type Locale } from '../i18n';
import { enumLabel } from '../projects/labels';
import { Badge, Button, EmptyState, Modal, Spinner, toast, type BadgeTone } from '../ui';
import { isOnline } from './api';
import { reportErrorText } from './errors';
import {
  cancelExport,
  downloadExport,
  downloadable,
  exportJobs,
  followedJobs,
  refreshJobs,
  requestExport,
  resumeExport,
} from './exportJobs';
import { STATUS_ORDER, TYPE_ORDER, RECORD_STATE_ORDER } from './Dashboard';
import { isObj, type ExportFormat, type ExportJob, type ExportLang, type ScopeRef } from './types';
import { scopeFilters } from './scope';

export interface ExportChoices {
  format: ExportFormat;
  lang: ExportLang;
  type: string;
  status: string;
  recordState: string;
  openMaintenance: boolean;
  incomplete: boolean;
}

export function defaultChoices(l: Locale): ExportChoices {
  return {
    format: 'xlsx',
    lang: l,
    type: '',
    status: '',
    recordState: '',
    openMaintenance: false,
    incomplete: false,
  };
}

/** `p_filters` of `export_request` for the dashboard scope plus the dialog's extra filters. */
export function exportFilters(scope: ScopeRef, c: ExportChoices): Record<string, unknown> {
  const filters: Record<string, unknown> = { ...scopeFilters(scope) };
  if (c.type) filters.type = c.type;
  if (c.status) filters.status = c.status;
  if (c.recordState) filters.record_state = c.recordState;
  if (c.openMaintenance) filters.has_open_maintenance = true;
  if (c.incomplete) filters.incomplete = true;
  return filters;
}

const LANGS: ExportLang[] = ['ar', 'sw', 'en'];

export interface ExportDialogProps {
  open: boolean;
  scope: ScopeRef;
  scopeLabel: string;
  choices: ExportChoices;
  onChoices: (next: ExportChoices) => void;
  onClose: () => void;
  onStarted: (job: ExportJob) => void;
}

/**
 * The choices live in the page (`choices` / `onChoices`): closing the dialog with Esc or the
 * close button keeps them for the next time — nothing the user picked is lost.
 */
export function ExportDialog(props: ExportDialogProps) {
  const { choices: c, onChoices } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ExportChoices>): void => onChoices({ ...c, ...patch });
  const restricted = can.seeRestricted.value;

  const submit = async (event?: Event): Promise<void> => {
    event?.preventDefault();
    if (busy) return;
    if (!isOnline()) {
      setError(t('reports.exportOffline'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const job = await requestExport({
        format: c.format,
        lang: c.lang,
        filters: exportFilters(props.scope, c),
      });
      toast(t('reports.exportStarted'), 'info');
      props.onStarted(job);
    } catch (e) {
      setError(reportErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const select = (
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    options: readonly string[],
    enumKey: string,
  ) => (
    <div class="field">
      <label class="field__label" for={id}>
        {label}
      </label>
      <select
        id={id}
        class="control select"
        data-testid={id}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
      >
        <option value="">{t('reports.filterAll')}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {enumLabel(enumKey, o)}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <Modal
      open={props.open}
      title={t('reports.exportTitle')}
      onClose={props.onClose}
      testId="export-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} testId="export-close">
            {t('reports.close')}
          </Button>
          <Button variant="gold" busy={busy} onClick={() => void submit()} testId="export-submit">
            {t('reports.exportStart')}
          </Button>
        </>
      }
    >
      <form class="rexport stack" onSubmit={(e) => void submit(e)}>
        <fieldset class="rexport__group">
          <legend class="field__label">{t('reports.exportFormat')}</legend>
          <div class="rchoice">
            {(['xlsx', 'csv'] as const).map((f) => (
              <label key={f} class={`rchoice__opt${c.format === f ? ' rchoice__opt--on' : ''}`}>
                <input
                  type="radio"
                  name="export-format"
                  value={f}
                  checked={c.format === f}
                  data-testid={`export-format-${f}`}
                  onChange={() => set({ format: f })}
                />
                <span>{t(`reports.format_${f}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset class="rexport__group">
          <legend class="field__label">{t('reports.exportLanguage')}</legend>
          <p class="field__hint">{t('reports.exportLanguageHint')}</p>
          <div class="rchoice">
            {LANGS.map((l) => (
              <label key={l} class={`rchoice__opt${c.lang === l ? ' rchoice__opt--on' : ''}`}>
                <input
                  type="radio"
                  name="export-lang"
                  value={l}
                  checked={c.lang === l}
                  data-testid={`export-lang-${l}`}
                  onChange={() => set({ lang: l })}
                />
                <span lang={l}>{t(`reports.lang_${l}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset class="rexport__group">
          <legend class="field__label">{t('reports.exportFilters')}</legend>
          <p class="rexport__scope" data-testid="export-scope">
            {t('reports.exportScope', { scope: props.scopeLabel })}
          </p>
          <div class="rexport__selects">
            {select(
              'export-filter-type',
              t('reports.colType'),
              c.type,
              (v) => set({ type: v }),
              TYPE_ORDER,
              'project_type',
            )}
            {select(
              'export-filter-status',
              t('reports.colStatus'),
              c.status,
              (v) => set({ status: v }),
              STATUS_ORDER,
              'project_status',
            )}
            {select(
              'export-filter-record-state',
              t('reports.colRecordState'),
              c.recordState,
              (v) => set({ recordState: v }),
              RECORD_STATE_ORDER,
              'record_state',
            )}
          </div>
          <label class="rcheck">
            <input
              type="checkbox"
              checked={c.openMaintenance}
              data-testid="export-filter-maintenance"
              onChange={(e) => set({ openMaintenance: e.currentTarget.checked })}
            />
            <span>{t('reports.filterOpenMaintenance')}</span>
          </label>
          <label class="rcheck">
            <input
              type="checkbox"
              checked={c.incomplete}
              data-testid="export-filter-incomplete"
              onChange={(e) => set({ incomplete: e.currentTarget.checked })}
            />
            <span>{t('reports.filterIncomplete')}</span>
          </label>
        </fieldset>
        <p
          class="rnote"
          data-testid="export-salary-note"
          data-restricted={restricted ? 'true' : 'false'}
        >
          {restricted ? t('reports.exportSalaryIncluded') : t('reports.exportSalaryExcluded')}
        </p>
        <p class="rnote">{t('reports.exportHow')}</p>
        {error && (
          <p class="field__error" role="alert" data-testid="export-error">
            {error}
          </p>
        )}
        {/* Enter in the form submits */}
        <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
      </form>
    </Modal>
  );
}

const STATE_TONE: Record<string, BadgeTone> = {
  queued: 'neutral',
  running: 'info',
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  expired: 'warning',
};

function filtersSummary(job: ExportJob, names: Map<string, string>): string {
  const f = job.filters;
  const parts: string[] = [];
  for (const key of ['country_id', 'branch_id'] as const) {
    const id = f[key];
    if (typeof id === 'string') parts.push(names.get(id) ?? t('reports.scopeUnknown'));
  }
  if (typeof f.type === 'string') parts.push(enumLabel('project_type', f.type));
  if (typeof f.status === 'string') parts.push(enumLabel('project_status', f.status));
  if (typeof f.record_state === 'string') parts.push(enumLabel('record_state', f.record_state));
  if (f.has_open_maintenance === true) parts.push(t('reports.filterOpenMaintenance'));
  if (f.incomplete === true) parts.push(t('reports.filterIncomplete'));
  return parts.length > 0 ? parts.join(t('reports.listSep')) : t('reports.scopeAll');
}

export interface ExportJobsProps {
  /** id → display name of countries / branches (for the filter summary). */
  names: Map<string, string>;
}

export function ExportJobs({ names }: ExportJobsProps) {
  const jobs = exportJobs.value;
  const followed = followedJobs.value;
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    if (!isOnline()) return;
    setLoading(true);
    setError(null);
    try {
      await refreshJobs();
    } catch (e) {
      setError(reportErrorText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    const onOnline = (): void => void reload();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  const act = async (job: ExportJob, action: 'download' | 'cancel' | 'resume'): Promise<void> => {
    if (!isOnline()) {
      toast(t('reports.offlineShort'), 'error');
      return;
    }
    setBusyId(`${job.id}:${action}`);
    try {
      if (action === 'download') await downloadExport({ ...job, job_id: job.id });
      else if (action === 'cancel') await cancelExport(job);
      else await resumeExport(job);
    } catch (e) {
      toast(reportErrorText(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div class="rjobs">
      <div class="rjobs__head">
        <h3 class="rcard__sub">{t('reports.pastExports')}</h3>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void reload()}
          busy={loading}
          testId="export-jobs-refresh"
        >
          {t('reports.refreshList')}
        </Button>
      </div>
      {error && (
        <p class="field__error" role="alert">
          {error}
        </p>
      )}
      {jobs.length === 0 ? (
        loading ? (
          <Spinner />
        ) : (
          <EmptyState
            title={t('reports.noExports')}
            message={isOnline() ? undefined : t('reports.exportsOffline')}
          />
        )
      ) : (
        <ul class="rjobs__list" aria-live="polite">
          {jobs.map((job) => {
            const active = job.state === 'queued' || job.state === 'running';
            const canDownload = job.state === 'done' && downloadable(job);
            return (
              <li
                key={job.id}
                class="rjob"
                data-testid="export-job-row"
                data-state={job.state}
                data-id={job.id}
              >
                <div class="rjob__main">
                  <Badge tone={STATE_TONE[job.state] ?? 'neutral'} testId="export-job-state">
                    {t(`reports.jobState_${job.state}`)}
                  </Badge>
                  <span class="rjob__what">
                    {t(`reports.format_${job.format}`)} · {t(`reports.lang_${job.lang}`)}
                  </span>
                  {active && followed.has(job.id) && <Spinner />}
                </div>
                <div class="rjob__meta muted">
                  <span>{filtersSummary(job, names)}</span>
                  {job.created_at && <span>{fmt.dateTime(job.created_at)}</span>}
                  {job.row_count !== null && (
                    <span>{t('reports.rows', { count: job.row_count })}</span>
                  )}
                  {job.bytes !== null && <span>{fmt.bytes(job.bytes)}</span>}
                  {job.state === 'done' && job.expires_at && (
                    <span>{t('reports.availableUntil', { date: fmt.date(job.expires_at) })}</span>
                  )}
                </div>
                {job.state === 'done' && isObj(job.stats.fallback) && (
                  <p class="rnote" data-testid="export-fallback">
                    {t('reports.fallbackCsv')}
                  </p>
                )}
                {job.state === 'failed' && (
                  <p class="rjob__error">{t('reports.exportFailedHelp')}</p>
                )}
                <div class="rjob__actions">
                  {canDownload && (
                    <Button
                      size="sm"
                      variant="primary"
                      busy={busyId === `${job.id}:download`}
                      onClick={() => void act(job, 'download')}
                      testId="export-download"
                    >
                      {t('reports.download')}
                    </Button>
                  )}
                  {job.state === 'queued' && !followed.has(job.id) && (
                    <Button
                      size="sm"
                      busy={busyId === `${job.id}:resume`}
                      onClick={() => void act(job, 'resume')}
                      testId="export-resume"
                    >
                      {t('reports.resume')}
                    </Button>
                  )}
                  {active && (
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={busyId === `${job.id}:cancel`}
                      onClick={() => void act(job, 'cancel')}
                      testId="export-cancel"
                    >
                      {t('reports.cancelExport')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p class="rnote">{t('reports.downloadNote')}</p>
    </div>
  );
}

/** Display names of the scope options (used by the job list). */
export function scopeNames(
  options: Array<{ id: string | null; country?: object; branch?: object }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const o of options) {
    if (!o.id) continue;
    const row = (o.country ?? o.branch) as Parameters<typeof pickName>[0];
    if (row) map.set(o.id, pickName(row));
  }
  return map;
}
