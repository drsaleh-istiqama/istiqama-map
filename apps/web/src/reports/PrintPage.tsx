/**
 * Print view `/reports/print/:kind/:id` (brief §9.4, ARCHITECTURE decision D4): an HTML page
 * laid out for A4 that the browser prints or saves as PDF ("Save as PDF" in the print dialog).
 *
 *   project → report_project()   donor → report_donor()   country → report_country()
 *
 * The data is read online only (the RPCs log restricted reads); offline the page says so.
 * RTL for Arabic, LTR for Swahili / English, corporate navy and gold. The running header and
 * footer repeat on every printed page (table header / footer groups); page numbers come from
 * the CSS page counters in `print.css`.
 */
import { useEffect, useState } from 'preact/hooks';
import { can } from '../auth';
import { dir, fmt, locale, t } from '../i18n';
import { navigate, useRoute } from '../routes';
import { Button, EmptyState, IconOffline, Spinner } from '../ui';
import { isOnline, reportsApi, type ReportKind } from './api';
import { reportErrorText } from './errors';
import { IconPrint } from './icons';
import { hasPayroll, PrintCountry } from './PrintCountry';
import { PrintDonor } from './PrintDonor';
import { hasSalaries, PrintProject } from './PrintProject';
import { useFxPlaceholder, useOnline } from './hooks';
import {
  parseCountryReport,
  parseDonorReport,
  parseProjectReport,
  type CountryReport,
  type DonorReport,
  type ProjectReport,
} from './types';
import './print.css';

type Loaded =
  | { kind: 'project'; report: ProjectReport }
  | { kind: 'donor'; report: DonorReport }
  | { kind: 'country'; report: CountryReport };

export function isReportKind(v: unknown): v is ReportKind {
  return v === 'project' || v === 'donor' || v === 'country';
}

function parse(kind: ReportKind, raw: unknown): Loaded {
  if (kind === 'project') return { kind, report: parseProjectReport(raw) };
  if (kind === 'donor') return { kind, report: parseDonorReport(raw) };
  return { kind, report: parseCountryReport(raw) };
}

const TITLE_KEY: Record<ReportKind, string> = {
  project: 'reports.printProjectCard',
  donor: 'reports.printDonorReport',
  country: 'reports.printCountryReport',
};

function goBack(): void {
  if (typeof window !== 'undefined' && window.history.length > 1) window.history.back();
  else navigate('/reports');
}

export default function PrintPage() {
  const route = useRoute();
  const kind = route.params.kind;
  const id = route.params.id ?? '';
  const online = useOnline();
  const fxPlaceholder = useFxPlaceholder();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSalaries, setShowSalaries] = useState(false);
  const [tick, setTick] = useState(0);

  // Another report: forget the previous document and the salary choice.
  useEffect(() => {
    setLoaded(null);
    setError(null);
    setShowSalaries(false);
  }, [kind, id]);

  useEffect(() => {
    if (!isReportKind(kind) || !id) return;
    if (!isOnline()) return;
    let alive = true;
    setLoading(true);
    setError(null);
    reportsApi()
      .report(kind, id)
      .then((raw) => alive && setLoaded(parse(kind, raw)))
      .catch((e: unknown) => alive && setError(reportErrorText(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [kind, id, tick, online]);

  // The document title becomes the default PDF file name; the shell's title comes back after.
  useEffect(() => {
    if (!loaded) return;
    const previous = document.title;
    const name =
      loaded.kind === 'project'
        ? (loaded.report.project.code ?? '')
        : loaded.kind === 'donor'
          ? (loaded.report.donor.name_latin ?? loaded.report.donor.name_ar ?? '')
          : (loaded.report.scope.iso2 ?? '');
    document.title = name ? `${t(TITLE_KEY[loaded.kind])} — ${name}` : t(TITLE_KEY[loaded.kind]);
    return () => {
      document.title = previous;
    };
  }, [loaded, locale.value]);

  // Salaries (project) / payroll (country) are printed only on request, and only when the
  // server sent them (restricted access).
  const salaryOption =
    loaded?.kind === 'project' && hasSalaries(loaded.report)
      ? t('reports.printIncludeSalaries')
      : loaded?.kind === 'country' && hasPayroll(loaded.report)
        ? t('reports.printIncludePayroll')
        : null;

  const toolbar = (
    <div class="ptoolbar" data-testid="print-toolbar">
      <Button variant="ghost" onClick={goBack} testId="print-back">
        {t('reports.back')}
      </Button>
      <span class="ptoolbar__spacer" />
      {salaryOption && (
        <label class="rcheck ptoolbar__opt">
          <input
            type="checkbox"
            checked={showSalaries}
            data-testid="print-show-salaries"
            onChange={(e) => setShowSalaries(e.currentTarget.checked)}
          />
          <span>{salaryOption}</span>
        </label>
      )}
      <Button
        variant="gold"
        icon={<IconPrint />}
        disabled={!loaded}
        onClick={() => window.print()}
        testId="print-button"
      >
        {t('reports.print')}
      </Button>
    </div>
  );

  let body;
  if (!isReportKind(kind) || !id) {
    body = (
      <EmptyState
        title={t('reports.printUnknownTitle')}
        message={t('reports.printUnknownBody')}
        testId="print-error"
      />
    );
  } else if (!online && !loaded) {
    body = (
      <EmptyState
        icon={<IconOffline size={40} />}
        title={t('reports.printOfflineTitle')}
        message={t('reports.printOfflineBody')}
        testId="print-offline"
      />
    );
  } else if (error && !loaded) {
    body = (
      <EmptyState
        title={t('reports.printErrorTitle')}
        message={error}
        testId="print-error"
        action={
          online ? (
            <Button onClick={() => setTick((n) => n + 1)} testId="print-retry">
              {t('reports.retry')}
            </Button>
          ) : undefined
        }
      />
    );
  } else if (!loaded || loading) {
    body = <Spinner />;
  }

  if (body) {
    return (
      <div class="pprint" data-testid="print-page">
        {toolbar}
        <div class="pprint__message">{body}</div>
      </div>
    );
  }

  const doc = loaded as Loaded;
  const generated = doc.report.generated_at ?? new Date().toISOString();
  return (
    <div class="pprint" data-testid="print-page">
      {toolbar}
      <article
        class="pdoc"
        dir={dir()}
        lang={locale.value}
        data-testid="print-doc"
        data-kind={doc.kind}
        aria-label={t(TITLE_KEY[doc.kind])}
      >
        <table class="pframe" role="presentation">
          <thead>
            <tr>
              <td>
                <header class="phead">
                  <span class="phead__mark" aria-hidden="true" />
                  <span class="phead__org">{t('reports.orgName')}</span>
                  <span class="phead__title">{t(TITLE_KEY[doc.kind])}</span>
                </header>
              </td>
            </tr>
          </thead>
          <tfoot>
            <tr>
              <td>
                <footer class="pfoot">
                  <span>{t('reports.generatedOn', { date: fmt.dateTime(generated) })}</span>
                  <span>{t('reports.confidential')}</span>
                </footer>
              </td>
            </tr>
          </tfoot>
          <tbody>
            <tr>
              <td class="pframe__body">
                {doc.kind === 'project' && (
                  <PrintProject report={doc.report} showSalaries={showSalaries} />
                )}
                {doc.kind === 'donor' && <PrintDonor report={doc.report} />}
                {doc.kind === 'country' && (
                  <PrintCountry
                    report={doc.report}
                    hideNames={!can.seePeople.value}
                    fxPlaceholder={fxPlaceholder}
                    showPayroll={showSalaries}
                  />
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </article>
    </div>
  );
}
