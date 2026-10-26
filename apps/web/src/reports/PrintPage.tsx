/**
 * Print view `/reports/print/:kind/:id` (brief §9.4, ARCHITECTURE decision D4): an HTML page
 * laid out for A4 that the browser prints or saves as PDF ("Save as PDF" in the print dialog).
 *
 *   project → report_project()   donor → report_donor()   country → report_country()
 *   summary/<scope key> → dashboard() of that scope (`global` = every country the user reads),
 *   printed with the country layout and no branch table — the "PDF" button of the reports page.
 *
 * The data is read online only (the RPCs log restricted reads); offline the page says so.
 * RTL for Arabic, LTR for Swahili / English, corporate navy and gold. The running header and
 * footer repeat on every printed page (table header / footer groups); page numbers come from
 * the CSS page counters in `print.css`.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { can } from '../auth';
import { dir, fmt, locale, pickName, t } from '../i18n';
import { navigate, useRoute } from '../routes';
import { Button, EmptyState, IconOffline, Modal, Spinner, toast } from '../ui';
import { isOnline, reportsApi, type ReportKind } from './api';
import { reportErrorText } from './errors';
import { IconPrint, IconShare } from './icons';
import { mailUrl, pdfFileName, sharePdf, whatsappUrl } from './share';
import { hasPayroll, PrintCountry } from './PrintCountry';
import { parseScopeKey } from './scope';
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

type PageKind = ReportKind | 'summary';

type Loaded =
  | { kind: 'project'; report: ProjectReport }
  | { kind: 'donor'; report: DonorReport }
  | { kind: 'country' | 'summary'; report: CountryReport };

export function isReportKind(v: unknown): v is ReportKind {
  return v === 'project' || v === 'donor' || v === 'country';
}

function isPageKind(v: unknown): v is PageKind {
  return isReportKind(v) || v === 'summary';
}

function parse(kind: PageKind, raw: unknown): Loaded {
  if (kind === 'project') return { kind, report: parseProjectReport(raw) };
  if (kind === 'donor') return { kind, report: parseDonorReport(raw) };
  return { kind, report: parseCountryReport(raw) };
}

function load(kind: PageKind, id: string): Promise<unknown> {
  if (kind !== 'summary') return reportsApi().report(kind, id);
  const scope = parseScopeKey(id);
  if (!scope) return Promise.reject(new Error(t('reports.printUnknownBody')));
  return reportsApi().dashboard(scope);
}

const TITLE_KEY: Record<PageKind, string> = {
  project: 'reports.printProjectCard',
  donor: 'reports.printDonorReport',
  country: 'reports.printCountryReport',
  summary: 'reports.printSummaryReport',
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
  const [sharing, setSharing] = useState(false);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const docRef = useRef<HTMLElement>(null);

  // Another report: forget the previous document and the salary choice.
  useEffect(() => {
    setLoaded(null);
    setError(null);
    setShowSalaries(false);
  }, [kind, id]);

  useEffect(() => {
    if (!isPageKind(kind) || !id) return;
    if (!isOnline()) return;
    let alive = true;
    setLoading(true);
    setError(null);
    load(kind, id)
      .then((raw) => alive && setLoaded(parse(kind, raw)))
      .catch((e: unknown) => alive && setError(reportErrorText(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [kind, id, tick, online]);

  const docTitle = loaded ? titleOf(loaded) : '';

  // The document title becomes the default PDF file name; the shell's title comes back after.
  useEffect(() => {
    if (!loaded) return;
    const previous = document.title;
    document.title = docTitle;
    return () => {
      document.title = previous;
    };
  }, [loaded, docTitle]);

  async function share(): Promise<void> {
    const el = docRef.current;
    if (!el || sharing) return;
    setSharing(true);
    try {
      const outcome = await sharePdf(el, docTitle, t('reports.shareMessage', { title: docTitle }));
      if (outcome === 'downloaded') setDownloaded(pdfFileName(docTitle));
    } catch (e) {
      console.error('share: PDF failed', e);
      toast(t('reports.shareFailed'), 'error');
    } finally {
      setSharing(false);
    }
  }

  // Salaries (project) / payroll (country) are printed only on request, and only when the
  // server sent them (restricted access).
  const salaryOption =
    loaded?.kind === 'project' && hasSalaries(loaded.report)
      ? t('reports.printIncludeSalaries')
      : (loaded?.kind === 'country' || loaded?.kind === 'summary') && hasPayroll(loaded.report)
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
        icon={<IconShare />}
        disabled={!loaded}
        busy={sharing}
        title={sharing ? t('reports.shareBusy') : undefined}
        onClick={() => void share()}
        testId="print-share"
      >
        {t('reports.share')}
      </Button>
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
  if (!isPageKind(kind) || !id) {
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
        ref={docRef}
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
                {(doc.kind === 'country' || doc.kind === 'summary') && (
                  <PrintCountry
                    report={doc.report}
                    kicker={t(TITLE_KEY[doc.kind])}
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
      <Modal
        open={downloaded !== null}
        title={t('reports.shareDownloadedTitle')}
        onClose={() => setDownloaded(null)}
        testId="share-dialog"
        footer={
          <Button variant="ghost" onClick={() => setDownloaded(null)}>
            {t('reports.close')}
          </Button>
        }
      >
        <p>{t('reports.shareDownloadedBody', { file: downloaded ?? '' })}</p>
        <div class="pshare">
          <a
            class="btn btn--gold"
            href={whatsappUrl(t('reports.shareMessage', { title: docTitle }))}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="share-whatsapp"
          >
            {t('reports.shareWhatsapp')}
          </a>
          <a
            class="btn btn--secondary"
            href={mailUrl(docTitle, t('reports.shareMessage', { title: docTitle }))}
            data-testid="share-email"
          >
            {t('reports.shareEmail')}
          </a>
        </div>
      </Modal>
    </div>
  );
}

/** Title of the document: report kind + its subject (also the PDF file name). */
function titleOf(loaded: Loaded): string {
  const kindTitle = t(TITLE_KEY[loaded.kind]);
  const name =
    loaded.kind === 'project'
      ? [loaded.report.project.code, pickName(loaded.report.project)].filter(Boolean).join(' ')
      : loaded.kind === 'donor'
        ? (loaded.report.donor.name_latin ?? loaded.report.donor.name_ar ?? '')
        : pickName(loaded.report.scope) ||
          (loaded.report.scope.iso2 ?? '') ||
          (loaded.kind === 'summary' ? t('reports.scopeGlobal') : '');
  return name ? `${kindTitle} — ${name}` : kindTitle;
}
