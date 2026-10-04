/**
 * Shapes of the report RPCs (docs/contracts/reports-import-export.md §2–4) and defensive
 * parsers. The server is the authority on what a role may see: a key the server leaves out
 * (`payroll`, `collectors`, `staff`, the salary columns) stays out — the parsers never invent
 * it. They only turn missing numbers into 0 and missing lists into [] so that a dashboard
 * cached by an older build still renders.
 */

export type ScopeType = 'global' | 'country' | 'branch';

export interface ScopeRef {
  type: ScopeType;
  id: string | null;
}

export interface Named {
  name_ar?: string | null;
  name_en?: string | null;
  name_sw?: string | null;
  name_latin?: string | null;
}

export interface DashboardScope extends Named {
  type: ScopeType;
  id: string | null;
  iso2?: string | null;
  code?: string | null;
  country_id?: string | null;
  default_currency?: string | null;
}

/** One line of `by_area` / `by_country` / `by_branch` (level-1 area, country or branch). */
export interface RegionRow extends Named {
  /** area_id / country_id / branch_id; null = "without area / branch". */
  id: string | null;
  code: string | null;
  iso2: string | null;
  country_id: string | null;
  projects: number;
  capacity: number;
  mosque: number;
  school: number;
  combined: number;
  /** Projects whose STATUS is maintenance. */
  maintenance: number;
}

export interface TypeStatusCell {
  type: string;
  status: string;
  projects: number;
  capacity: number;
}

export interface MaintenanceItem {
  id: string;
  project_id: string | null;
  project_code: string | null;
  project_name_ar: string | null;
  project_name_latin: string | null;
  priority: string;
  state: string;
  reported_on: string | null;
  description: string | null;
  estimated_cost: number | null;
  currency: string | null;
}

export interface MoneyLine {
  currency: string;
  amount: number;
  amount_usd: number | null;
}

export interface PayrollLine {
  currency: string;
  staff_paid: number;
  monthly_total: number;
  usd_per_unit: number | null;
  rate_date: string | null;
  monthly_total_usd: number | null;
}

export interface Payroll {
  staff_paid: number;
  by_currency: PayrollLine[];
  monthly_total_usd: number | null;
  missing_rates: string[];
}

export interface Needs {
  quran_need: number;
  quran_count: number;
  quran_need_projects: number;
  teacher_housing_gaps: number;
  imam_housing_gaps: number;
  housing_gaps: number;
  transport_needed: number;
  expandable_sites: number;
}

export interface Completeness {
  projects: number;
  average: number | null;
  incomplete: number;
  complete: number;
  below_half: number;
}

export interface WeekCount {
  week_start: string;
  created: number;
  updated: number;
}

export interface Collector {
  user_id: string;
  full_name: string | null;
  created: number;
  updated: number;
  weeks: WeekCount[];
}

export interface EntryActivity {
  weeks: string[];
  totals: WeekCount[];
  collector_count: number;
  /** Absent for viewers (the server omits user names). */
  collectors?: Collector[];
}

export interface Dashboard {
  scope: DashboardScope;
  last_refreshed_at: string | null;
  generated_at: string | null;
  totals: {
    projects: number;
    capacity: number;
    areas_covered: number;
    by_type: Record<string, number>;
    by_status: Record<string, number>;
    capacity_by_type: Record<string, number>;
    by_record_state: Record<string, number>;
    by_type_status: TypeStatusCell[];
    by_area: RegionRow[];
    by_country?: RegionRow[];
    by_branch?: RegionRow[];
  };
  maintenance: {
    open_total: number;
    by_priority: Record<string, number>;
    estimated_cost: MoneyLine[];
    items: MaintenanceItem[];
  };
  staff: { assignments: number; by_role: Record<string, number> };
  /** Present only for callers with restricted access to the scope's country. */
  payroll?: Payroll;
  needs: Needs;
  completeness: Completeness;
  entry_activity: EntryActivity;
}

// ---------------------------------------------------------------------------------------------
// Primitive readers
// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function counts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isObj(v)) for (const [k, n] of Object.entries(v)) out[k] = num(n);
  return out;
}

function named(o: Obj): Named {
  return {
    name_ar: str(o.name_ar),
    name_en: str(o.name_en),
    name_sw: str(o.name_sw),
    ...(o.name_latin !== undefined ? { name_latin: str(o.name_latin) } : {}),
  };
}

function region(v: unknown, idKey: string): RegionRow {
  const o = isObj(v) ? v : {};
  return {
    ...named(o),
    id: str(o[idKey]),
    code: str(o.code),
    iso2: str(o.iso2),
    country_id: str(o.country_id),
    projects: num(o.projects),
    capacity: num(o.capacity),
    mosque: num(o.mosque),
    school: num(o.school),
    combined: num(o.combined),
    maintenance: num(o.maintenance),
  };
}

function week(v: unknown): WeekCount {
  const o = isObj(v) ? v : {};
  return { week_start: str(o.week_start) ?? '', created: num(o.created), updated: num(o.updated) };
}

export function parsePayroll(v: unknown): Payroll | undefined {
  if (!isObj(v)) return undefined;
  return {
    staff_paid: num(v.staff_paid),
    by_currency: arr(v.by_currency)
      .filter(isObj)
      .map((l) => ({
        currency: str(l.currency) ?? '',
        staff_paid: num(l.staff_paid),
        monthly_total: num(l.monthly_total),
        usd_per_unit: numOrNull(l.usd_per_unit),
        rate_date: str(l.rate_date),
        monthly_total_usd: numOrNull(l.monthly_total_usd),
      })),
    monthly_total_usd: numOrNull(v.monthly_total_usd),
    missing_rates: arr(v.missing_rates).filter((c): c is string => typeof c === 'string'),
  };
}

// ---------------------------------------------------------------------------------------------
// dashboard()
// ---------------------------------------------------------------------------------------------

export function parseDashboard(raw: unknown): Dashboard {
  const o = isObj(raw) ? raw : {};
  const scope = isObj(o.scope) ? o.scope : {};
  const totals = isObj(o.totals) ? o.totals : {};
  const maint = isObj(o.maintenance) ? o.maintenance : {};
  const staff = isObj(o.staff) ? o.staff : {};
  const needs = isObj(o.needs) ? o.needs : {};
  const comp = isObj(o.completeness) ? o.completeness : {};
  const act = isObj(o.entry_activity) ? o.entry_activity : {};
  const type = scope.type === 'country' || scope.type === 'branch' ? scope.type : 'global';

  const dashboard: Dashboard = {
    scope: {
      ...named(scope),
      type,
      id: str(scope.id),
      iso2: str(scope.iso2),
      code: str(scope.code),
      country_id: str(scope.country_id),
      default_currency: str(scope.default_currency),
    },
    last_refreshed_at: str(o.last_refreshed_at),
    generated_at: str(o.generated_at),
    totals: {
      projects: num(totals.projects),
      capacity: num(totals.capacity),
      areas_covered: num(totals.areas_covered),
      by_type: counts(totals.by_type),
      by_status: counts(totals.by_status),
      capacity_by_type: counts(totals.capacity_by_type),
      by_record_state: counts(totals.by_record_state),
      by_type_status: arr(totals.by_type_status)
        .filter(isObj)
        .map((c) => ({
          type: str(c.type) ?? '',
          status: str(c.status) ?? '',
          projects: num(c.projects),
          capacity: num(c.capacity),
        })),
      by_area: arr(totals.by_area).map((r) => region(r, 'area_id')),
      ...(Array.isArray(totals.by_country)
        ? { by_country: totals.by_country.map((r) => region(r, 'country_id')) }
        : {}),
      ...(Array.isArray(totals.by_branch)
        ? { by_branch: totals.by_branch.map((r) => region(r, 'branch_id')) }
        : {}),
    },
    maintenance: {
      open_total: num(maint.open_total),
      by_priority: counts(maint.by_priority),
      estimated_cost: arr(maint.estimated_cost)
        .filter(isObj)
        .map((m) => ({
          currency: str(m.currency) ?? '',
          amount: num(m.amount),
          amount_usd: numOrNull(m.amount_usd),
        })),
      items: arr(maint.items)
        .filter(isObj)
        .map((i) => ({
          id: str(i.id) ?? '',
          project_id: str(i.project_id),
          project_code: str(i.project_code),
          project_name_ar: str(i.project_name_ar),
          project_name_latin: str(i.project_name_latin),
          priority: str(i.priority) ?? '',
          state: str(i.state) ?? '',
          reported_on: str(i.reported_on),
          description: str(i.description),
          estimated_cost: numOrNull(i.estimated_cost),
          currency: str(i.currency),
        })),
    },
    staff: { assignments: num(staff.assignments), by_role: counts(staff.by_role) },
    needs: {
      quran_need: num(needs.quran_need),
      quran_count: num(needs.quran_count),
      quran_need_projects: num(needs.quran_need_projects),
      teacher_housing_gaps: num(needs.teacher_housing_gaps),
      imam_housing_gaps: num(needs.imam_housing_gaps),
      housing_gaps: num(needs.housing_gaps),
      transport_needed: num(needs.transport_needed),
      expandable_sites: num(needs.expandable_sites),
    },
    completeness: {
      projects: num(comp.projects),
      average: numOrNull(comp.average),
      incomplete: num(comp.incomplete),
      complete: num(comp.complete),
      below_half: num(comp.below_half),
    },
    entry_activity: {
      weeks: arr(act.weeks).filter((w): w is string => typeof w === 'string'),
      totals: arr(act.totals).map(week),
      collector_count: num(act.collector_count),
      ...(Array.isArray(act.collectors)
        ? {
            collectors: act.collectors.filter(isObj).map((c) => ({
              user_id: str(c.user_id) ?? '',
              full_name: str(c.full_name),
              created: num(c.created),
              updated: num(c.updated),
              weeks: arr(c.weeks).map(week),
            })),
          }
        : {}),
    },
  };
  const payroll = parsePayroll(o.payroll);
  if (payroll) dashboard.payroll = payroll;
  return dashboard;
}

// ---------------------------------------------------------------------------------------------
// report_country() = dashboard + branches
// ---------------------------------------------------------------------------------------------

export interface BranchReportRow extends Named {
  branch_id: string | null;
  code: string | null;
  projects: number;
  capacity: number;
  approved: number;
  by_type: Record<string, number>;
  by_status: Record<string, number>;
  open_maintenance: number;
  urgent_maintenance: number;
  staff: number;
  quran_need: number;
  housing_gaps: number;
  transport_needed: number;
  expandable_sites: number;
  completeness_average: number | null;
  incomplete: number;
  payroll?: {
    by_currency: Array<{
      currency: string;
      staff_paid: number;
      monthly_total: number;
      monthly_total_usd: number | null;
    }>;
    monthly_total_usd: number | null;
  };
}

export interface CountryReport extends Dashboard {
  branches: BranchReportRow[];
}

export function parseCountryReport(raw: unknown): CountryReport {
  const o = isObj(raw) ? raw : {};
  return {
    ...parseDashboard(raw),
    branches: arr(o.branches)
      .filter(isObj)
      .map((b) => {
        const row: BranchReportRow = {
          ...named(b),
          branch_id: str(b.branch_id),
          code: str(b.code),
          projects: num(b.projects),
          capacity: num(b.capacity),
          approved: num(b.approved),
          by_type: counts(b.by_type),
          by_status: counts(b.by_status),
          open_maintenance: num(b.open_maintenance),
          urgent_maintenance: num(b.urgent_maintenance),
          staff: num(b.staff),
          quran_need: num(b.quran_need),
          housing_gaps: num(b.housing_gaps),
          transport_needed: num(b.transport_needed),
          expandable_sites: num(b.expandable_sites),
          completeness_average: numOrNull(b.completeness_average),
          incomplete: num(b.incomplete),
        };
        if (isObj(b.payroll)) {
          row.payroll = {
            by_currency: arr(b.payroll.by_currency)
              .filter(isObj)
              .map((l) => ({
                currency: str(l.currency) ?? '',
                staff_paid: num(l.staff_paid),
                monthly_total: num(l.monthly_total),
                monthly_total_usd: numOrNull(l.monthly_total_usd),
              })),
            monthly_total_usd: numOrNull(b.payroll.monthly_total_usd),
          };
        }
        return row;
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// report_project() / report_donor() — kept close to the wire; the print views read them.
// ---------------------------------------------------------------------------------------------

export interface ReportPhoto {
  id: string;
  storage_path_thumb: string | null;
  storage_path_full: string | null;
  is_cover: boolean;
  category: string | null;
  caption: string | null;
  taken_at: string | null;
}

export interface ReportStaff {
  project_staff_id: string;
  person_id: string | null;
  person_visible: boolean;
  name_ar: string | null;
  name_latin: string | null;
  role: string;
  start_date: string | null;
  end_date: string | null;
  phone: string | null;
  /** The three salary keys exist only with restricted access. */
  monthly_amount?: number | null;
  currency?: string | null;
  effective_from?: string | null;
}

export interface AdminAreaRef extends Named {
  id: string;
  level: number;
  code: string | null;
}

export interface ProjectReport {
  generated_at: string | null;
  capabilities: { people: boolean; restricted: boolean };
  project: Obj & {
    id: string;
    code: string | null;
    name_ar: string | null;
    name_latin: string | null;
    type: string | null;
    status: string | null;
    record_state: string | null;
    lon: number | null;
    lat: number | null;
  };
  country: (Named & { id: string; iso2: string | null }) | null;
  admin_areas: AdminAreaRef[];
  locality: { id: string; name_ar: string | null; name_latin: string | null } | null;
  branch: (Named & { id: string; code: string | null }) | null;
  land: Obj | null;
  facilities: Obj | null;
  community: (Obj & { lists?: Record<string, { options: Named[]; other: string | null }> }) | null;
  photos: ReportPhoto[];
  donors: Array<{
    id: string;
    name_ar: string | null;
    name_latin: string | null;
    amount: number | null;
    currency: string | null;
    year: number | null;
  }>;
  maintenance: Array<{
    id: string;
    reported_on: string | null;
    description: string | null;
    priority: string;
    state: string;
    estimated_cost: number | null;
    currency: string | null;
    resolved_on: string | null;
  }>;
  staff_count: number;
  /** Absent for viewers. */
  staff?: ReportStaff[];
  entered_by?: { id: string | null; full_name: string | null };
}

function photo(v: unknown): ReportPhoto {
  const p = isObj(v) ? v : {};
  return {
    id: str(p.id) ?? '',
    storage_path_thumb: str(p.storage_path_thumb),
    storage_path_full: str(p.storage_path_full),
    is_cover: p.is_cover === true,
    category: str(p.category),
    caption: str(p.caption),
    taken_at: str(p.taken_at),
  };
}

export function parseProjectReport(raw: unknown): ProjectReport {
  const o = isObj(raw) ? raw : {};
  const p = isObj(o.project) ? o.project : {};
  const caps = isObj(o.capabilities) ? o.capabilities : {};
  const country = isObj(o.country) ? o.country : null;
  const branch = isObj(o.branch) ? o.branch : null;
  const locality = isObj(o.locality) ? o.locality : null;
  const community = isObj(o.community) ? o.community : null;
  const report: ProjectReport = {
    generated_at: str(o.generated_at),
    capabilities: { people: caps.people === true, restricted: caps.restricted === true },
    project: {
      ...p,
      id: str(p.id) ?? '',
      code: str(p.code),
      name_ar: str(p.name_ar),
      name_latin: str(p.name_latin),
      type: str(p.type),
      status: str(p.status),
      record_state: str(p.record_state),
      lon: numOrNull(p.lon),
      lat: numOrNull(p.lat),
    },
    country: country
      ? { ...named(country), id: str(country.id) ?? '', iso2: str(country.iso2) }
      : null,
    admin_areas: arr(o.admin_areas)
      .filter(isObj)
      .map((a) => ({ ...named(a), id: str(a.id) ?? '', level: num(a.level), code: str(a.code) }))
      .sort((a, b) => a.level - b.level),
    locality: locality
      ? {
          id: str(locality.id) ?? '',
          name_ar: str(locality.name_ar),
          name_latin: str(locality.name_latin),
        }
      : null,
    branch: branch ? { ...named(branch), id: str(branch.id) ?? '', code: str(branch.code) } : null,
    land: isObj(o.land) ? o.land : null,
    facilities: isObj(o.facilities) ? o.facilities : null,
    community: community as ProjectReport['community'],
    photos: arr(o.photos).map(photo),
    donors: arr(o.donors)
      .filter(isObj)
      .map((d) => ({
        id: str(d.id) ?? '',
        name_ar: str(d.name_ar),
        name_latin: str(d.name_latin),
        amount: numOrNull(d.amount),
        currency: str(d.currency),
        year: numOrNull(d.year),
      })),
    maintenance: arr(o.maintenance)
      .filter(isObj)
      .map((m) => ({
        id: str(m.id) ?? '',
        reported_on: str(m.reported_on),
        description: str(m.description),
        priority: str(m.priority) ?? '',
        state: str(m.state) ?? '',
        estimated_cost: numOrNull(m.estimated_cost),
        currency: str(m.currency),
        resolved_on: str(m.resolved_on),
      })),
    staff_count: num(o.staff_count),
  };
  if (Array.isArray(o.staff)) {
    report.staff = o.staff.filter(isObj).map((s) => {
      const row: ReportStaff = {
        project_staff_id: str(s.project_staff_id) ?? '',
        person_id: str(s.person_id),
        person_visible: s.person_visible !== false,
        name_ar: str(s.name_ar),
        name_latin: str(s.name_latin),
        role: str(s.role) ?? '',
        start_date: str(s.start_date),
        end_date: str(s.end_date),
        phone: str(s.phone),
      };
      if ('monthly_amount' in s) {
        row.monthly_amount = numOrNull(s.monthly_amount);
        row.currency = str(s.currency);
        row.effective_from = str(s.effective_from);
      }
      return row;
    });
  }
  if (isObj(o.entered_by)) {
    report.entered_by = { id: str(o.entered_by.id), full_name: str(o.entered_by.full_name) };
  }
  return report;
}

export interface DonorProject {
  id: string;
  code: string | null;
  name_ar: string | null;
  name_latin: string | null;
  type: string | null;
  status: string | null;
  record_state: string | null;
  capacity: number | null;
  build_year: number | null;
  lon: number | null;
  lat: number | null;
  country: (Named & { id: string | null; iso2: string | null }) | null;
  admin_area: (Named & { id: string | null; level: number }) | null;
  locality: { id: string | null; name_ar: string | null; name_latin: string | null } | null;
  contributions: Array<{ amount: number | null; currency: string | null; year: number | null }>;
  open_maintenance: number;
  photos: ReportPhoto[];
}

export interface DonorReport {
  generated_at: string | null;
  donor: { id: string; name_ar: string | null; name_latin: string | null; notes: string | null };
  summary: {
    projects: number;
    capacity: number;
    by_type: Record<string, number>;
    by_status: Record<string, number>;
    contributions: Array<{ currency: string; amount: number }>;
  };
  projects: DonorProject[];
  projects_total: number;
  truncated: boolean;
}

export function parseDonorReport(raw: unknown): DonorReport {
  const o = isObj(raw) ? raw : {};
  const d = isObj(o.donor) ? o.donor : {};
  const s = isObj(o.summary) ? o.summary : {};
  return {
    generated_at: str(o.generated_at),
    donor: {
      id: str(d.id) ?? '',
      name_ar: str(d.name_ar),
      name_latin: str(d.name_latin),
      notes: str(d.notes),
    },
    summary: {
      projects: num(s.projects),
      capacity: num(s.capacity),
      by_type: counts(s.by_type),
      by_status: counts(s.by_status),
      contributions: arr(s.contributions)
        .filter(isObj)
        .map((c) => ({ currency: str(c.currency) ?? '', amount: num(c.amount) })),
    },
    projects: arr(o.projects)
      .filter(isObj)
      .map((p) => {
        const country = isObj(p.country) ? p.country : null;
        const area = isObj(p.admin_area) ? p.admin_area : null;
        const locality = isObj(p.locality) ? p.locality : null;
        return {
          id: str(p.id) ?? '',
          code: str(p.code),
          name_ar: str(p.name_ar),
          name_latin: str(p.name_latin),
          type: str(p.type),
          status: str(p.status),
          record_state: str(p.record_state),
          capacity: numOrNull(p.capacity),
          build_year: numOrNull(p.build_year),
          lon: numOrNull(p.lon),
          lat: numOrNull(p.lat),
          country: country
            ? { ...named(country), id: str(country.id), iso2: str(country.iso2) }
            : null,
          admin_area: area ? { ...named(area), id: str(area.id), level: num(area.level) } : null,
          locality: locality
            ? {
                id: str(locality.id),
                name_ar: str(locality.name_ar),
                name_latin: str(locality.name_latin),
              }
            : null,
          contributions: arr(p.contributions)
            .filter(isObj)
            .map((c) => ({
              amount: numOrNull(c.amount),
              currency: str(c.currency),
              year: numOrNull(c.year),
            })),
          open_maintenance: num(p.open_maintenance),
          photos: arr(p.photos).map(photo),
        };
      }),
    projects_total: num(o.projects_total),
    truncated: o.truncated === true,
  };
}

// ---------------------------------------------------------------------------------------------
// export_jobs rows and notifications
// ---------------------------------------------------------------------------------------------

export type ExportFormat = 'csv' | 'xlsx';
export type ExportLang = 'ar' | 'sw' | 'en';
export type ExportState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired';

export const EXPORT_TERMINAL: ReadonlySet<string> = new Set([
  'done',
  'failed',
  'cancelled',
  'expired',
]);

export interface ExportJob {
  id: string;
  format: ExportFormat;
  lang: ExportLang;
  filters: Obj;
  state: ExportState;
  storage_path: string | null;
  file_name: string | null;
  bytes: number | null;
  row_count: number | null;
  error: unknown;
  stats: Obj;
  attempts: number;
  created_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  expires_at: string | null;
}

export function parseExportJob(raw: unknown): ExportJob | null {
  if (!isObj(raw) || typeof raw.id !== 'string') return null;
  const state = str(raw.state) ?? 'queued';
  return {
    id: raw.id,
    format: raw.format === 'xlsx' ? 'xlsx' : 'csv',
    lang: raw.lang === 'sw' || raw.lang === 'en' ? raw.lang : 'ar',
    filters: isObj(raw.filters) ? raw.filters : {},
    state: (['queued', 'running', 'done', 'failed', 'cancelled', 'expired'].includes(state)
      ? state
      : 'queued') as ExportState,
    storage_path: str(raw.storage_path),
    file_name: str(raw.file_name),
    bytes: numOrNull(raw.bytes),
    row_count: numOrNull(raw.row_count),
    error: raw.error ?? null,
    stats: isObj(raw.stats) ? raw.stats : {},
    attempts: num(raw.attempts),
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
    finished_at: str(raw.finished_at),
    expires_at: str(raw.expires_at),
  };
}

/** Payload of an `export.ready` / `export.failed` notification. */
export interface ExportNotice {
  job_id: string | null;
  format: string | null;
  lang: string | null;
  storage_path: string | null;
  file_name: string | null;
  bytes: number | null;
  row_count: number | null;
  expires_at: string | null;
  error: string | null;
}

export function parseExportNotice(payload: unknown): ExportNotice {
  const p = isObj(payload) ? payload : {};
  return {
    job_id: str(p.job_id),
    format: str(p.format),
    lang: str(p.lang),
    storage_path: str(p.storage_path),
    file_name: str(p.file_name),
    bytes: numOrNull(p.bytes),
    row_count: numOrNull(p.row_count),
    expires_at: str(p.expires_at),
    error: typeof p.error === 'string' ? p.error : p.error ? JSON.stringify(p.error) : null,
  };
}
