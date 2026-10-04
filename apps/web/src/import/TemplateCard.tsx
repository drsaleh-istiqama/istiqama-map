/**
 * Step 1 — the official template: language of the headers, CSV (UTF-8 with BOM) or XLSX
 * (with a guide sheet), and the list of columns with what each one accepts.
 */
import { useState } from 'preact/hooks';
import { fmt, locale, t, type Locale } from '../i18n';
import { Button, Select, toast } from '../ui';
import { importApi } from './api';
import { importErrorText } from './labels';
import {
  guideRows,
  saveBlob,
  templateCsv,
  templateFileName,
  templateXlsx,
  type GuideLabels,
} from './template';
import type { ImportTemplate } from './types';

export function guideLabels(): GuideLabels {
  return {
    sheetData: t('import.sheetData'),
    sheetGuide: t('import.sheetGuide'),
    column: t('import.guideColumn'),
    key: t('import.guideKey'),
    required: t('import.guideRequired'),
    kind: t('import.guideKind'),
    allowed: t('import.guideAllowed'),
    example: t('import.guideExample'),
    yes: t('import.yes'),
    no: t('import.no'),
    range: (min, max) =>
      min !== null && max !== null
        ? t('import.range', { min: fmt.number(min), max: fmt.number(max) })
        : min !== null
          ? t('import.rangeMin', { min: fmt.number(min) })
          : t('import.rangeMax', { max: fmt.number(max ?? 0) }),
  };
}

const LANG_OPTIONS: Array<{ value: Locale; key: string }> = [
  { value: 'ar', key: 'import.langAr' },
  { value: 'sw', key: 'import.langSw' },
  { value: 'en', key: 'import.langEn' },
];

export interface TemplateCardProps {
  online: boolean;
  /** Templates already fetched, by language (shared with the page for field labels). */
  cache: Map<string, ImportTemplate>;
}

export function TemplateCard({ online, cache }: TemplateCardProps) {
  const [lang, setLang] = useState<Locale>(locale.value);
  const [busy, setBusy] = useState<'csv' | 'xlsx' | 'guide' | null>(null);
  const [guide, setGuide] = useState<ImportTemplate | null>(null);

  const load = async (l: Locale): Promise<ImportTemplate> => {
    const cached = cache.get(l);
    if (cached) return cached;
    const tpl = await importApi().template(l);
    cache.set(l, tpl);
    return tpl;
  };

  const download = async (kind: 'csv' | 'xlsx'): Promise<void> => {
    setBusy(kind);
    try {
      const tpl = await load(lang);
      const blob = kind === 'csv' ? templateCsv(tpl) : await templateXlsx(tpl, guideLabels());
      saveBlob(blob, templateFileName(tpl, kind));
      toast(t('import.templateSaved'), 'success');
    } catch (e) {
      toast(importErrorText(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const showGuide = async (): Promise<void> => {
    if (guide && guide.lang === lang) {
      setGuide(null);
      return;
    }
    setBusy('guide');
    try {
      setGuide(await load(lang));
    } catch (e) {
      toast(importErrorText(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const rows = guide ? guideRows(guide, guideLabels()) : [];

  return (
    <section
      class="card imp-step"
      aria-labelledby="imp-template-title"
      data-testid="import-template"
    >
      <h2 id="imp-template-title">
        <span class="imp-step__no" aria-hidden="true">
          1
        </span>
        {t('import.templateTitle')}
      </h2>
      <p class="muted">{t('import.templateHint')}</p>
      <div class="row imp-template__actions">
        <label class="imp-inline-field">
          <span>{t('import.templateLang')}</span>
          <Select
            value={lang}
            onChange={(v) => {
              setLang(v as Locale);
              setGuide(null);
            }}
            options={LANG_OPTIONS.map((o) => ({ value: o.value, label: t(o.key) }))}
            testId="import-template-lang"
          />
        </label>
        <Button
          variant="primary"
          onClick={() => void download('csv')}
          busy={busy === 'csv'}
          disabled={!online || busy !== null}
          testId="import-template-csv"
        >
          {t('import.templateCsv')}
        </Button>
        <Button
          onClick={() => void download('xlsx')}
          busy={busy === 'xlsx'}
          disabled={!online || busy !== null}
          testId="import-template-xlsx"
        >
          {t('import.templateXlsx')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => void showGuide()}
          busy={busy === 'guide'}
          disabled={!online || (busy !== null && busy !== 'guide')}
          aria-expanded={guide !== null}
          testId="import-template-guide"
        >
          {guide ? t('import.guideHide') : t('import.guideShow')}
        </Button>
      </div>
      <ul class="imp-limits">
        <li>{t('import.limitRows', { count: fmt.number(guide?.maxRows ?? 5000) })}</li>
        <li>{t('import.limitSize', { size: fmt.bytes(10 * 1024 * 1024) })}</li>
        <li>{t('import.limitMerge')}</li>
        <li>{t('import.limitNotImportable')}</li>
      </ul>
      {guide && (
        <div class="imp-guide" dir={guide.dir}>
          <table class="imp-table" data-testid="import-guide-table">
            <thead>
              <tr>
                {rows[0]!.map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((r) => (
                <tr key={r[1]}>
                  <th scope="row">{r[0]}</th>
                  <td>
                    <code class="ltr">{r[1]}</code>
                  </td>
                  <td>{r[2]}</td>
                  <td>
                    <code class="ltr">{r[3]}</code>
                  </td>
                  <td>{r[4]}</td>
                  <td>{r[5]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
