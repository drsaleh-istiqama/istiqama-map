import { describe, expect, it } from 'vitest';
import { countryReportFor, dashboardFor, donorReport, projectReportFor } from './testkit';
import {
  parseCountryReport,
  parseDashboard,
  parseDonorReport,
  parseExportJob,
  parseExportNotice,
  parseProjectReport,
} from './types';

describe('parseDashboard', () => {
  it('keeps what the server sent and invents nothing for a viewer', () => {
    const d = parseDashboard(dashboardFor('viewer'));
    expect(d.scope).toMatchObject({ type: 'global', id: null });
    expect(d.totals.projects).toBe(33);
    expect(d.totals.by_type).toEqual({ mosque: 14, school: 11, combined: 8 });
    expect(d.totals.by_branch?.[1]?.id).toBeNull();
    expect(d.maintenance.items[0]?.priority).toBe('urgent');
    expect(d.entry_activity.totals).toHaveLength(12);
    expect('collectors' in d.entry_activity).toBe(false);
    expect('payroll' in d).toBe(false);
  });

  it('reads payroll per currency for restricted roles', () => {
    const d = parseDashboard(dashboardFor('country_manager'));
    expect(d.payroll?.by_currency.map((l) => l.currency)).toEqual(['TZS', 'KES', 'XAF']);
    expect(d.payroll?.by_currency[2]?.monthly_total_usd).toBeNull();
    expect(d.payroll?.monthly_total_usd).toBe(2526.2);
    expect(d.payroll?.missing_rates).toEqual(['XAF']);
    expect(d.entry_activity.collectors).toHaveLength(2);
  });

  it('survives garbage and older cached shapes', () => {
    const d = parseDashboard({
      totals: { projects: '7', by_type: { mosque: 'x' } },
      completeness: { average: null },
    });
    expect(d.totals.projects).toBe(7);
    expect(d.totals.by_type.mosque).toBe(0);
    expect(d.totals.by_area).toEqual([]);
    expect(d.completeness.average).toBeNull();
    expect(parseDashboard(null).scope.type).toBe('global');
  });
});

describe('parseCountryReport', () => {
  it('adds the branch rows; payroll only when sent', () => {
    const m = parseCountryReport(countryReportFor('country_manager'));
    expect(m.scope).toMatchObject({ type: 'country', iso2: 'TZ' });
    expect(m.branches).toHaveLength(2);
    expect(m.branches[0]?.payroll?.monthly_total_usd).toBe(1489.6);
    expect(m.branches[1]?.branch_id).toBeNull();
    const v = parseCountryReport(countryReportFor('viewer'));
    expect(v.branches.every((b) => b.payroll === undefined)).toBe(true);
    expect(v.payroll).toBeUndefined();
  });
});

describe('parseProjectReport', () => {
  it('has no staff list for viewers, only the count', () => {
    const r = parseProjectReport(projectReportFor('viewer'));
    expect(r.staff).toBeUndefined();
    expect(r.staff_count).toBe(2);
    expect(r.entered_by).toBeUndefined();
    expect(r.admin_areas.map((a) => a.level)).toEqual([1, 2]);
  });

  it('keeps salary keys only when the server sent them', () => {
    const c = parseProjectReport(projectReportFor('field_collector'));
    expect(c.staff).toHaveLength(2);
    expect(c.staff?.every((s) => !('monthly_amount' in s))).toBe(true);
    expect(c.staff?.[1]?.person_visible).toBe(false);
    const m = parseProjectReport(projectReportFor('country_manager'));
    expect(m.staff?.[0]?.monthly_amount).toBe(340000);
    expect(m.capabilities.restricted).toBe(true);
  });
});

describe('parseDonorReport / export rows', () => {
  it('reads the donor report', () => {
    const r = parseDonorReport(donorReport());
    expect(r.donor.name_latin).toBe('Muhsin');
    expect(r.projects[0]?.photos[0]?.is_cover).toBe(true);
    expect(r.summary.contributions).toEqual([{ currency: 'USD', amount: 5000 }]);
  });

  it('parses export jobs defensively', () => {
    expect(parseExportJob({ id: 'j', format: 'xlsx', state: 'done', bytes: '1200' })).toMatchObject(
      {
        id: 'j',
        format: 'xlsx',
        state: 'done',
        bytes: 1200,
        lang: 'ar',
      },
    );
    expect(parseExportJob({ id: 'j', state: 'weird' })?.state).toBe('queued');
    expect(parseExportJob({ format: 'csv' })).toBeNull();
  });

  it('parses notification payloads', () => {
    const n = parseExportNotice({
      job_id: 'j',
      storage_path: 'u/j.csv',
      row_count: 12,
      error: { code: 'x' },
    });
    expect(n).toMatchObject({
      job_id: 'j',
      storage_path: 'u/j.csv',
      row_count: 12,
      error: '{"code":"x"}',
    });
    expect(parseExportNotice(null).storage_path).toBeNull();
  });
});
