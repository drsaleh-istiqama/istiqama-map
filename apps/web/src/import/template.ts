/**
 * The official import template, built on the device from `import_template(lang)`:
 *   - CSV: UTF-8 with BOM (src/lib/csv), one header row in the chosen language;
 *   - XLSX: the same header row on the FIRST sheet (the server reads the first visible sheet)
 *     plus a guide sheet (required columns, allowed values, examples). SheetJS is loaded only
 *     here, on demand (web.md §1: never statically outside its own module).
 */
import { toCsv } from '../lib/csv';
import type { ImportTemplate, TemplateColumn } from './types';

export interface GuideLabels {
  sheetData: string;
  sheetGuide: string;
  column: string;
  key: string;
  required: string;
  kind: string;
  allowed: string;
  example: string;
  yes: string;
  no: string;
  range: (min: number | null, max: number | null) => string;
}

export function headerRow(tpl: ImportTemplate): string[] {
  return tpl.columns.map((c) => c.header);
}

export function templateFileName(tpl: ImportTemplate, ext: 'csv' | 'xlsx'): string {
  return `istiqama-import-template-${tpl.lang}-v${tpl.version}.${ext}`;
}

export function templateCsv(tpl: ImportTemplate): Blob {
  return new Blob([toCsv([headerRow(tpl)])], { type: 'text/csv;charset=utf-8' });
}

function allowedText(c: TemplateColumn, separator: string): string {
  return c.allowed
    .map((a) => (a.label && a.label !== a.code ? `${a.label} (${a.code})` : a.code))
    .join(` ${separator} `);
}

/** Rows of the guide sheet (also shown on the page). */
export function guideRows(tpl: ImportTemplate, labels: GuideLabels): string[][] {
  const rows: string[][] = [
    [labels.column, labels.key, labels.required, labels.kind, labels.allowed, labels.example],
  ];
  for (const c of tpl.columns) {
    const allowed =
      c.allowed.length > 0
        ? allowedText(c, tpl.listSeparator)
        : c.min !== null || c.max !== null
          ? labels.range(c.min, c.max)
          : '';
    rows.push([
      c.header,
      c.key,
      c.required ? labels.yes : labels.no,
      c.kind,
      allowed,
      c.example ?? '',
    ]);
  }
  return rows;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function templateXlsx(tpl: ImportTemplate, labels: GuideLabels): Promise<Blob> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const data = XLSX.utils.aoa_to_sheet([headerRow(tpl)]);
  data['!cols'] = tpl.columns.map((c) => ({
    wch: Math.max(12, Math.min(40, c.header.length + 4)),
  }));
  XLSX.utils.book_append_sheet(wb, data, labels.sheetData.slice(0, 31));
  const guide = XLSX.utils.aoa_to_sheet(guideRows(tpl, labels));
  guide['!cols'] = [{ wch: 28 }, { wch: 22 }, { wch: 10 }, { wch: 10 }, { wch: 60 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, guide, labels.sheetGuide.slice(0, 31));
  if (tpl.dir === 'rtl') wb.Workbook = { Views: [{ RTL: true }] };
  const bytes = XLSX.write(wb, {
    bookType: 'xlsx',
    type: 'array',
    compression: true,
  }) as ArrayBuffer;
  return new Blob([bytes], { type: XLSX_MIME });
}

/** Hands a file to the browser's download manager. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
