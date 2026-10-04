/**
 * Test doubles of the reports module (not imported by application code):
 *
 *   vi.mock('../auth', async () => (await import('./testkit')).authModule());
 *   vi.mock('../sync', async () => (await import('./testkit')).syncModule());
 *
 * `useRole()` switches the signed-in user (role, read scope, scope epoch); `FakeReportsApi`
 * replaces every server call of the module (`setReportsApi(api)`); the `fixture*` builders
 * return report payloads shaped exactly like the live RPCs of the staging stack (captured on
 * 2026-10-04) — with the parts each role really receives.
 */
import { computed, signal } from '@preact/signals';
import { vi } from 'vitest';
import type { ExportRequestInput, ReportKind, ReportsApi } from './api';
import type { ExportJob, ScopeRef } from './types';

export const USER = '0a000000-0000-4000-8000-00000000000a';
export const TZ = 'e2a6484f-39a5-3135-816a-03ad934d99fd';
export const KE = '7510d42a-4721-335a-845c-c1218318061a';
export const PEMBA = '58372685-bb04-3409-b7fa-17b08890ee4a';
export const TANGA = '2b94c85e-6fa1-32d4-97d5-8dfaebaea137';
export const PROJECT = '6cb13674-e8c8-3ed6-87df-0328074150d8';
export const DONOR = 'd0000000-0000-4000-8000-0000000000d1';

export type TestRole =
  'viewer' | 'field_collector' | 'branch_supervisor' | 'country_manager' | 'hq_admin';

interface RoleSetup {
  seePeople: boolean;
  seeRestricted: boolean;
  write: boolean;
  review: boolean;
  admin: boolean;
  read: { all: boolean; countries: string[]; branches: string[] };
}

const ROLES: Record<TestRole, RoleSetup> = {
  viewer: {
    seePeople: false,
    seeRestricted: false,
    write: false,
    review: false,
    admin: false,
    read: { all: true, countries: [], branches: [] },
  },
  field_collector: {
    seePeople: true,
    seeRestricted: false,
    write: true,
    review: false,
    admin: false,
    read: { all: false, countries: [], branches: [PEMBA] },
  },
  branch_supervisor: {
    seePeople: true,
    seeRestricted: false,
    write: true,
    review: true,
    admin: false,
    read: { all: false, countries: [], branches: [PEMBA] },
  },
  country_manager: {
    seePeople: true,
    seeRestricted: true,
    write: true,
    review: true,
    admin: false,
    read: { all: false, countries: [TZ], branches: [] },
  },
  hq_admin: {
    seePeople: true,
    seeRestricted: true,
    write: true,
    review: true,
    admin: true,
    read: { all: true, countries: [], branches: [] },
  },
};

const role = signal<TestRole>('viewer');
const epoch = signal('epoch-1');
const userId = signal(USER);
const readOverride = signal<RoleSetup['read'] | null>(null);

export function useRole(
  next: TestRole,
  opts: { epoch?: string; user?: string; read?: RoleSetup['read'] } = {},
): void {
  role.value = next;
  epoch.value = opts.epoch ?? 'epoch-1';
  userId.value = opts.user ?? USER;
  readOverride.value = opts.read ?? null;
}

let auth: Record<string, unknown> | null = null;

export function authModule(): Record<string, unknown> {
  if (auth) return auth;
  const me = computed(() => ({
    user_id: userId.value,
    profile: {
      id: userId.value,
      full_name: 'Amina Juma',
      phone: null,
      preferred_language: 'ar',
      active: true,
    },
    roles: [{ role: role.value, scope_type: 'global', scope_id: null }],
    scopes: { read: readOverride.value ?? ROLES[role.value].read },
    scope_epoch: epoch.value,
  }));
  const flag = (k: Exclude<keyof RoleSetup, 'read'>) => computed(() => ROLES[role.value][k]);
  auth = {
    me,
    session: computed(() => ({ user: { id: userId.value } })),
    can: {
      write: flag('write'),
      review: flag('review'),
      seePeople: flag('seePeople'),
      seeRestricted: flag('seeRestricted'),
      admin: flag('admin'),
      manage: flag('admin'),
    },
    supabase: {},
    deviceId: () => 'device-test-0001',
  };
  return auth;
}

export const syncMocks = {
  syncNow: vi.fn(async () => undefined),
  rpc: vi.fn(async (_fn: string, _args?: Record<string, unknown>): Promise<unknown> => null),
};

let sync: Record<string, unknown> | null = null;

class SyncError extends Error {
  readonly kind: string;
  constructor(kind: string, message = kind) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
  }
}

export function syncError(kind: string): Error {
  return new SyncError(kind);
}

export function syncModule(): Record<string, unknown> {
  if (sync) return sync;
  sync = {
    syncStatus: signal({
      online: true,
      state: 'idle',
      pendingOps: 0,
      pendingPhotos: 0,
      failedOps: 0,
      lastSyncAt: null,
      lastError: null,
    }),
    syncNow: (...args: unknown[]) =>
      (syncMocks.syncNow as (...a: unknown[]) => Promise<undefined>)(...args),
    transport: {
      rpc: (fn: string, args?: Record<string, unknown>) => syncMocks.rpc(fn, args),
      push: async () => [],
      pull: async () => ({ changes: [], cursor: null, done: true }),
    },
    SyncError,
    isSyncError: (e: unknown) => e instanceof SyncError,
    errorKey: (e: { kind?: string }) => `sync.error_${e.kind ?? 'unknown'}`,
    startSync: () => undefined,
    stopSync: () => undefined,
    enqueuePhotoUpload: async () => undefined,
    resetLocalData: async () => undefined,
    WIFI_ONLY_PREF_KEY: 'sync.wifiOnly',
  };
  return sync;
}

/** Sets `navigator.onLine` and fires the matching window event. */
export function setOnline(online: boolean, fire = false): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  if (fire) window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

export function resetSyncMocks(): void {
  syncMocks.syncNow.mockReset();
  syncMocks.syncNow.mockImplementation(async () => undefined);
  syncMocks.rpc.mockReset();
  syncMocks.rpc.mockImplementation(async () => null);
  setOnline(true);
}

// ---------------------------------------------------------------------------------------------
// Server double
// ---------------------------------------------------------------------------------------------

/** Every call of the module's server API, as spies with sensible defaults. */
export class FakeReportsApi implements ReportsApi {
  jobs = new Map<string, ExportJob>();
  dashboard = vi.fn(async (_scope: ScopeRef): Promise<unknown> => dashboardFor('viewer'));
  report = vi.fn(async (_kind: ReportKind, _id: string): Promise<unknown> => ({}));
  adminAreaShapes = vi.fn(async (_c: string, _l: number): Promise<unknown> => ({
    type: 'FeatureCollection',
    features: [],
  }));
  exportRequest = vi.fn(async (input: ExportRequestInput): Promise<ExportJob> => {
    const job = exportJob({
      id: `job-${this.jobs.size + 1}`,
      format: input.format,
      lang: input.lang,
      filters: input.filters,
    });
    this.jobs.set(job.id, job);
    return job;
  });
  exportStart = vi.fn(async (_jobId: string): Promise<void> => undefined);
  exportJob = vi.fn(
    async (jobId: string): Promise<ExportJob | null> => this.jobs.get(jobId) ?? null,
  );
  exportJobs = vi.fn(async (_limit: number): Promise<ExportJob[]> =>
    [...this.jobs.values()].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')),
  );
  exportCancel = vi.fn(async (jobId: string): Promise<void> => {
    const job = this.jobs.get(jobId);
    if (job) this.jobs.set(jobId, { ...job, state: 'cancelled' });
  });
  exportDownloadUrl = vi.fn(async (jobId: string): Promise<string> => {
    const path = this.jobs.get(jobId)?.storage_path ?? `${jobId}.bin`;
    return `https://storage.test/sign/${path}?token=t`;
  });

  /** Moves a job forward as the Edge Function would. */
  setJob(id: string, patch: Partial<ExportJob>): void {
    const job = this.jobs.get(id);
    if (job) this.jobs.set(id, { ...job, ...patch });
  }
}

let jobClock = 0;

export function exportJob(values: Partial<ExportJob> = {}): ExportJob {
  jobClock++;
  return {
    id: `job-${jobClock}`,
    format: 'xlsx',
    lang: 'ar',
    filters: {},
    state: 'queued',
    storage_path: null,
    file_name: null,
    bytes: null,
    row_count: null,
    error: null,
    stats: {},
    attempts: 0,
    created_at: `2026-10-04T10:${String(jobClock % 60).padStart(2, '0')}:00Z`,
    updated_at: null,
    finished_at: null,
    expires_at: null,
    ...values,
  };
}

// ---------------------------------------------------------------------------------------------
// Fixtures (shapes of the live RPCs; numbers shortened)
// ---------------------------------------------------------------------------------------------

const WEEKS = [
  '2026-07-13',
  '2026-07-20',
  '2026-07-27',
  '2026-08-03',
  '2026-08-10',
  '2026-08-17',
  '2026-08-24',
  '2026-08-31',
  '2026-09-07',
  '2026-09-14',
  '2026-09-21',
  '2026-09-28',
];

/** dashboard() as each role receives it: viewers get no collector names, only restricted roles get payroll. */
export function dashboardFor(
  who: TestRole,
  scope: Record<string, unknown> = { id: null, type: 'global' },
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    scope,
    last_refreshed_at: '2026-10-04T16:51:45.110089+00:00',
    generated_at: '2026-10-04T17:00:00+00:00',
    totals: {
      projects: 33,
      capacity: 5960,
      areas_covered: 5,
      by_type: { mosque: 14, school: 11, combined: 8 },
      by_status: { active: 24, maintenance: 4, building: 3, inactive: 2 },
      capacity_by_type: { mosque: 2100, school: 2300, combined: 1560 },
      by_record_state: { draft: 6, submitted: 3, approved: 22, returned: 2 },
      by_type_status: [
        { type: 'mosque', status: 'active', projects: 10, capacity: 1500 },
        { type: 'school', status: 'maintenance', projects: 2, capacity: 400 },
      ],
      by_area: [
        {
          area_id: 'a1',
          country_id: TZ,
          code: 'PN',
          name_ar: 'بيمبا الشمالية',
          name_en: 'North Pemba',
          name_sw: 'Kaskazini Pemba',
          projects: 9,
          capacity: 1550,
          mosque: 5,
          school: 3,
          combined: 1,
          maintenance: 1,
        },
      ],
      by_country: [
        {
          country_id: TZ,
          iso2: 'TZ',
          name_ar: 'تنزانيا',
          name_en: 'Tanzania',
          name_sw: 'Tanzania',
          projects: 20,
          capacity: 4000,
          mosque: 9,
          school: 7,
          combined: 4,
          maintenance: 2,
        },
      ],
      by_branch: [
        {
          branch_id: PEMBA,
          code: 'PEMBA',
          country_id: TZ,
          name_ar: 'فرع بيمبا',
          name_en: 'Pemba branch',
          name_sw: 'Tawi la Pemba',
          projects: 16,
          capacity: 2910,
          mosque: 7,
          school: 6,
          combined: 3,
          maintenance: 2,
        },
        {
          branch_id: null,
          code: null,
          country_id: TZ,
          name_ar: null,
          name_en: null,
          name_sw: null,
          projects: 1,
          capacity: 0,
          mosque: 1,
          school: 0,
          combined: 0,
          maintenance: 0,
        },
      ],
    },
    maintenance: {
      open_total: 5,
      by_priority: { urgent: 1, high: 2, medium: 1, low: 1 },
      estimated_cost: [{ currency: 'TZS', amount: 10200000, amount_usd: 3876 }],
      items: [
        {
          id: 'm1',
          project_id: PROJECT,
          project_code: 'TZ-TG-000024',
          project_name_ar: 'مسجد ومدرسة الهجرة',
          project_name_latin: 'Masjid na Madrasa Al-Hijra',
          priority: 'urgent',
          state: 'open',
          reported_on: '2026-09-20',
          description: 'Roof of the prayer hall at risk.',
          estimated_cost: 4200000,
          currency: 'TZS',
        },
      ],
    },
    staff: {
      assignments: 26,
      by_role: { imam: 9, teacher: 8, agent: 1, administrator: 1, manager: 6, other: 1 },
    },
    needs: {
      quran_need: 1120,
      quran_count: 2400,
      quran_need_projects: 19,
      teacher_housing_gaps: 7,
      imam_housing_gaps: 4,
      housing_gaps: 11,
      transport_needed: 7,
      expandable_sites: 8,
    },
    completeness: { projects: 33, average: 64.4, incomplete: 33, complete: 0, below_half: 12 },
    entry_activity: {
      weeks: WEEKS,
      totals: WEEKS.map((w, i) => ({
        week_start: w,
        created: i === 2 ? 2 : i === 3 ? 3 : 0,
        updated: i === 11 ? 4 : 0,
      })),
      collector_count: 2,
    },
  };
  if (who !== 'viewer') {
    (doc.entry_activity as Record<string, unknown>).collectors = [
      {
        user_id: 'u1',
        full_name: 'Salim Collector',
        created: 5,
        updated: 1,
        weeks: [{ week_start: '2026-07-27', created: 2, updated: 0 }],
      },
      {
        user_id: 'u2',
        full_name: 'Zawadi Ali',
        created: 3,
        updated: 3,
        weeks: [{ week_start: '2026-09-28', created: 0, updated: 3 }],
      },
    ];
  }
  if (who === 'country_manager' || who === 'hq_admin') {
    doc.payroll = {
      staff_paid: 20,
      by_currency: [
        {
          currency: 'TZS',
          staff_paid: 18,
          monthly_total: 6040000,
          usd_per_unit: 0.00038,
          rate_date: '2025-01-01',
          monthly_total_usd: 2295.2,
        },
        {
          currency: 'KES',
          staff_paid: 1,
          monthly_total: 30000,
          usd_per_unit: 0.0077,
          rate_date: '2025-01-01',
          monthly_total_usd: 231,
        },
        {
          currency: 'XAF',
          staff_paid: 1,
          monthly_total: 1000,
          usd_per_unit: null,
          rate_date: null,
          monthly_total_usd: null,
        },
      ],
      monthly_total_usd: 2526.2,
      missing_rates: ['XAF'],
    };
  }
  return doc;
}

export function countryReportFor(who: TestRole): Record<string, unknown> {
  const doc = dashboardFor(who, {
    type: 'country',
    id: TZ,
    iso2: 'TZ',
    name_ar: 'تنزانيا',
    name_en: 'Tanzania',
    name_sw: 'Tanzania',
    default_currency: 'TZS',
  });
  const restricted = who === 'country_manager' || who === 'hq_admin';
  doc.branches = [
    {
      branch_id: PEMBA,
      code: 'PEMBA',
      name_ar: 'فرع بيمبا',
      name_en: 'Pemba branch',
      name_sw: 'Tawi la Pemba',
      projects: 16,
      capacity: 2910,
      approved: 11,
      by_type: { mosque: 7, school: 6, combined: 3 },
      by_status: { active: 11, maintenance: 2, building: 2, inactive: 1 },
      open_maintenance: 2,
      urgent_maintenance: 0,
      staff: 14,
      quran_need: 500,
      housing_gaps: 5,
      transport_needed: 4,
      expandable_sites: 5,
      completeness_average: 63.1,
      incomplete: 16,
      ...(restricted
        ? {
            payroll: {
              by_currency: [
                {
                  currency: 'TZS',
                  staff_paid: 12,
                  monthly_total: 3920000,
                  monthly_total_usd: 1489.6,
                },
              ],
              monthly_total_usd: 1489.6,
            },
          }
        : {}),
    },
    {
      branch_id: null,
      code: null,
      name_ar: null,
      name_en: null,
      name_sw: null,
      projects: 1,
      capacity: 0,
      approved: 0,
      by_type: { mosque: 1, school: 0, combined: 0 },
      by_status: { active: 1, maintenance: 0, building: 0, inactive: 0 },
      open_maintenance: 0,
      urgent_maintenance: 0,
      staff: 0,
      quran_need: 0,
      housing_gaps: 0,
      transport_needed: 0,
      expandable_sites: 0,
      completeness_average: null,
      incomplete: 1,
      ...(restricted ? { payroll: { by_currency: [], monthly_total_usd: null } } : {}),
    },
  ];
  return doc;
}

/** report_project(): `staff` absent for viewers, the three salary keys only with restricted access. */
export function projectReportFor(who: TestRole): Record<string, unknown> {
  const restricted = who === 'country_manager' || who === 'hq_admin';
  const doc: Record<string, unknown> = {
    generated_at: '2026-10-04T17:05:00+00:00',
    capabilities: { people: who !== 'viewer', restricted },
    project: {
      id: PROJECT,
      code: 'TZ-TG-000024',
      name_ar: 'مسجد ومدرسة الهجرة',
      name_latin: 'Masjid na Madrasa Al-Hijra',
      type: 'combined',
      status: 'maintenance',
      record_state: 'approved',
      capacity: 250,
      builder: 'Istiqama',
      build_year: 2011,
      build_date: null,
      location_source: 'gps',
      gps_accuracy_m: 8,
      completeness: 72.5,
      review_note: null,
      lon: 38.95,
      lat: -5.07,
    },
    country: { id: TZ, iso2: 'TZ', name_ar: 'تنزانيا', name_en: 'Tanzania', name_sw: 'Tanzania' },
    admin_areas: [
      {
        id: 'a2',
        level: 2,
        code: 'TG-1',
        name_ar: 'تانغا المدينة',
        name_en: 'Tanga City',
        name_sw: 'Jiji la Tanga',
      },
      { id: 'a1', level: 1, code: 'TG', name_ar: 'تانغا', name_en: 'Tanga', name_sw: 'Tanga' },
    ],
    locality: { id: 'l1', name_ar: 'شومبو', name_latin: 'Chumbageni', status: 'approved' },
    branch: {
      id: TANGA,
      code: 'TANGA',
      name_ar: 'فرع تانغا',
      name_en: 'Tanga branch',
      name_sw: 'Tawi la Tanga',
    },
    land: {
      ownership: 'waqf',
      area_m2: 1700,
      utilization_pct: 65,
      expandable: true,
      notes: null,
      ...(who !== 'viewer' ? { owner_name: 'Waqf committee' } : {}),
    },
    facilities: {
      teacher_housing: false,
      imam_housing: true,
      guest_housing: null,
      library: true,
      quran_count: 40,
      quran_need: 60,
      hall: true,
      hall_capacity: 120,
      student_transport: 'none',
      students_origin: 'local',
    },
    community: {
      branch_name: 'Chumbageni',
      population: 4200,
      muslim_pct: 85,
      lists: {
        daawa_activities: {
          options: [
            { id: 'o1', code: 'lessons', name_ar: 'دروس', name_en: 'Lessons', name_sw: 'Darasa' },
          ],
          other: 'Radio',
        },
      },
    },
    photos: [
      {
        id: 'ph1',
        storage_path_thumb: 'TZ/p/ph1_t.webp',
        storage_path_full: 'TZ/p/ph1.webp',
        is_cover: true,
        category: 'exterior',
        caption: 'Front',
        taken_at: null,
        width: 1600,
        height: 1200,
      },
      {
        id: 'ph2',
        storage_path_thumb: 'TZ/p/ph2_t.webp',
        storage_path_full: 'TZ/p/ph2.webp',
        is_cover: false,
        category: 'interior',
        caption: null,
        taken_at: null,
        width: 1600,
        height: 1200,
      },
    ],
    donors: [
      {
        id: 'pd1',
        donor_id: DONOR,
        name_ar: 'محسن',
        name_latin: 'Muhsin',
        amount: 5000,
        currency: 'USD',
        year: 2011,
      },
    ],
    maintenance: [
      {
        id: 'm1',
        reported_on: '2026-09-20',
        description: 'Roof at risk',
        priority: 'urgent',
        state: 'open',
        estimated_cost: 4200000,
        currency: 'TZS',
        resolved_on: null,
      },
    ],
    staff_count: 2,
  };
  if (who !== 'viewer') {
    const salary = (amount: number) =>
      restricted ? { monthly_amount: amount, currency: 'TZS', effective_from: '2025-01-01' } : {};
    doc.staff = [
      {
        project_staff_id: 's1',
        person_id: 'p1',
        person_visible: true,
        name_ar: 'بكر محمد',
        name_latin: 'Bakari Mohamed',
        role: 'imam',
        start_date: '2013-11-01',
        end_date: null,
        phone: '+255711000118',
        gender: 'male',
        birth_year: 1979,
        education_level: null,
        graduated_from: null,
        ...salary(340000),
      },
      {
        project_staff_id: 's2',
        person_id: null,
        person_visible: false,
        name_ar: null,
        name_latin: null,
        role: 'teacher',
        start_date: '2020-01-01',
        end_date: null,
        phone: null,
        gender: null,
        birth_year: null,
        education_level: null,
        graduated_from: null,
        ...salary(200000),
      },
    ];
    doc.entered_by = { id: 'u1', full_name: 'Salim Collector' };
  }
  if (restricted) doc.sensitive = { ibadi_families: 3 };
  return doc;
}

export function donorReport(): Record<string, unknown> {
  return {
    generated_at: '2026-10-04T17:05:00+00:00',
    donor: { id: DONOR, name_ar: 'محسن', name_latin: 'Muhsin', notes: 'Long-time supporter' },
    summary: {
      projects: 1,
      capacity: 250,
      by_type: { combined: 1 },
      by_status: { maintenance: 1 },
      contributions: [{ currency: 'USD', amount: 5000 }],
    },
    projects: [
      {
        id: PROJECT,
        code: 'TZ-TG-000024',
        name_ar: 'مسجد ومدرسة الهجرة',
        name_latin: 'Masjid na Madrasa Al-Hijra',
        type: 'combined',
        status: 'maintenance',
        record_state: 'approved',
        capacity: 250,
        build_year: 2011,
        lon: 38.95,
        lat: -5.07,
        country: {
          id: TZ,
          iso2: 'TZ',
          name_ar: 'تنزانيا',
          name_en: 'Tanzania',
          name_sw: 'Tanzania',
        },
        admin_area: { id: 'a1', level: 1, name_ar: 'تانغا', name_en: 'Tanga', name_sw: 'Tanga' },
        locality: null,
        contributions: [{ amount: 5000, currency: 'USD', year: 2011 }],
        open_maintenance: 1,
        photos: [
          {
            id: 'ph1',
            storage_path_thumb: 'TZ/p/ph1_t.webp',
            storage_path_full: 'TZ/p/ph1.webp',
            is_cover: true,
            category: 'exterior',
            caption: null,
            taken_at: null,
          },
        ],
      },
    ],
    projects_total: 1,
    truncated: false,
  };
}
