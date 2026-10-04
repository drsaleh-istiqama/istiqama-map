import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

import { applyServerRows, db, type Row } from '../db';
import { freshDb, serverProject, serverRow, USER_A, USER_B } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { navigate } from '../routes';
import { directionLinks } from './DetailsSections';
import ProjectDetailsPage from './ProjectDetailsPage';
import { loadProjectDetails } from './queries';
import { resetSyncMocks, syncMocks, useRole, type TestRole } from './testkit';

const P = '00000000-0080-7000-8000-00000000aaaa';

interface Seed {
  country: Row<'countries'>;
  person: Row<'persons'>;
  staff: Row<'project_staff'>;
}

async function seedProject(values: Partial<Row<'projects'>> = {}): Promise<Seed> {
  const country = serverRow('countries', {
    iso2: 'TZ',
    name_ar: 'تنزانيا',
    name_en: 'Tanzania',
    name_sw: 'Tanzania',
    default_currency: 'TZS',
    active: true,
  });
  const area = serverRow('admin_areas', {
    country_id: country.id,
    level: 1,
    code: 'TZ-PN',
    name_ar: 'شمال بيمبا',
    name_en: 'Pemba North',
    name_sw: 'Pemba Kaskazini',
  });
  await applyServerRows('countries', [country]);
  await applyServerRows('admin_areas', [area]);
  await applyServerRows('fx_rates', [
    serverRow('fx_rates', { currency: 'TZS', usd_per_unit: 0.0004, effective_date: '2026-01-01' }),
  ]);
  await applyServerRows('projects', [
    serverProject({
      id: P,
      name_ar: 'مسجد النور',
      name_latin: 'Masjid Nur',
      code: 'TZ-PN-000001',
      country_id: country.id,
      admin_area_id: area.id,
      lon: 39.75,
      lat: -5.05,
      gps_accuracy_m: 8,
      location_source: 'gps',
      capacity: 120,
      record_state: 'submitted',
      created_by: USER_B,
      ...values,
    }),
  ]);
  await applyServerRows('project_land', [
    serverRow('project_land', {
      project_id: P,
      ownership: 'person',
      owner_name: 'Khamis Owner',
      area_m2: 500,
    }),
  ]);
  const person = serverRow('persons', {
    name_ar: 'سالم بن خميس',
    name_latin: 'Salim Khamis',
    phone_e164: '+255700000001',
  });
  await applyServerRows('persons', [person]);
  const staff = serverRow('project_staff', {
    project_id: P,
    person_id: person.id,
    role: 'imam',
    start_date: '2020-01-01',
  });
  await applyServerRows('project_staff', [staff]);
  await applyServerRows('staff_compensation', [
    serverRow('staff_compensation', {
      project_staff_id: staff.id,
      monthly_amount: 250000,
      currency: 'TZS',
      effective_from: '2026-02-01',
    }),
  ]);
  await applyServerRows('community_sensitive', [
    serverRow('community_sensitive', { project_id: P, ibadi_families: 7 }),
  ]);
  const donor = serverRow('donors', { name_ar: 'محسن', name_latin: 'Generous Donor' });
  await applyServerRows('donors', [donor]);
  await applyServerRows('project_donors', [
    serverRow('project_donors', {
      project_id: P,
      donor_id: donor.id,
      amount: 5000,
      currency: 'USD',
      year: 2024,
    }),
  ]);
  await applyServerRows('project_maintenance', [
    serverRow('project_maintenance', {
      project_id: P,
      description: 'Roof leaks',
      priority: 'high',
      state: 'open',
      reported_on: '2026-09-01',
    }),
  ]);
  await applyServerRows('project_photos', [
    serverRow('project_photos', {
      project_id: P,
      storage_path_full: `projects/TZ/${P}/ph1_full.webp`,
      storage_path_thumb: `projects/TZ/${P}/ph1_thumb.webp`,
      category: 'mosque_front',
      caption: 'Main gate',
      is_cover: true,
      upload_state: 'pending',
    }),
  ]);
  return { country, person, staff };
}

async function openDetails(id = P): Promise<void> {
  navigate(`/projects/${id}`);
  render(<ProjectDetailsPage />);
  await screen.findByTestId('details-name');
}

beforeEach(async () => {
  await freshDb({ canSeeRestricted: true });
  await setLocale('en');
  resetSyncMocks();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('details card per role', () => {
  it('viewer: no names, phones, salaries, land owner or restricted data; no actions', async () => {
    await seedProject();
    useRole('viewer');
    await openDetails();
    expect(screen.getByTestId('details-name').textContent).toBe('Masjid Nur');
    expect(screen.getByTestId('staff-hidden')).toBeTruthy();
    expect(screen.queryByTestId('staff-name')).toBeNull();
    expect(screen.queryByTestId('staff-phone')).toBeNull();
    expect(screen.queryByTestId('staff-salary')).toBeNull();
    expect(screen.queryByTestId('details-sensitive')).toBeNull();
    expect(document.body.textContent).not.toContain('Salim Khamis');
    expect(document.body.textContent).not.toContain('+255700000001');
    expect(document.body.textContent).not.toContain('Khamis Owner');
    expect(document.body.textContent).not.toContain('250,000');
    for (const id of [
      'details-edit',
      'details-delete',
      'review-approve',
      'review-return',
      'maintenance-add',
    ])
      expect(screen.queryByTestId(id)).toBeNull();
    // donors are not people data: shown to viewers (donor relations)
    expect(within(screen.getByTestId('details-donors')).getByText('Generous Donor')).toBeTruthy();
  });

  it('field collector: names and phones, but no salary and no restricted section', async () => {
    await seedProject();
    useRole('field_collector');
    await openDetails();
    expect(screen.getByTestId('staff-name').textContent).toBe('Salim Khamis');
    expect(screen.getByTestId('staff-phone').getAttribute('href')).toBe('tel:+255700000001');
    expect(screen.getByText('Khamis Owner')).toBeTruthy();
    expect(screen.queryByTestId('staff-salary')).toBeNull();
    expect(screen.queryByTestId('details-sensitive')).toBeNull();
  });

  it('country manager: salary in its currency with the USD equivalent, and the restricted section', async () => {
    await seedProject();
    useRole('country_manager');
    await openDetails();
    const salary = screen.getByTestId('staff-salary').textContent ?? '';
    expect(salary).toContain('TZS');
    expect(salary).toContain('250,000');
    expect(salary).toMatch(/USD\s?100\.00/);
    const sensitive = screen.getByTestId('details-sensitive');
    expect(within(sensitive).getByText('7')).toBeTruthy();
  });

  it('shows the location with directions (geo: and Google Maps)', async () => {
    await seedProject();
    useRole('viewer');
    await openDetails();
    expect(screen.getByTestId('details-coordinates').textContent).toBe('-5.050000, 39.750000');
    expect(screen.getByTestId('details-directions-geo').getAttribute('href')).toBe(
      'geo:-5.05,39.75?q=-5.05,39.75',
    );
    expect(screen.getByTestId('details-directions-google').getAttribute('href')).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=-5.05%2C39.75',
    );
    expect(directionLinks(1, 2).geo).toBe('geo:1,2?q=1,2');
    expect(screen.getByTestId('details-print').getAttribute('href')).toBe(
      `/reports/print/project/${P}`,
    );
  });

  it('header shows type, status, record state, sync state and place', async () => {
    await seedProject();
    useRole('field_collector');
    await openDetails();
    expect(screen.getByTestId('details-type').textContent).toContain('Mosque');
    expect(screen.getByTestId('details-code').textContent).toBe('TZ-PN-000001');
    expect(screen.getByTestId('details-record-state').textContent).toBe('Submitted');
    expect(screen.getByTestId('details-sync').getAttribute('data-state')).toBe('synced');
    expect(
      screen.getByTestId('project-details').querySelector('.pdetails__place')?.textContent,
    ).toBe('Pemba North · Tanzania');
    // photo gallery of src/photos, thumbnails only
    expect(screen.getByTestId('gallery')).toBeTruthy();
    expect(screen.getAllByTestId('photo-gallery-item')).toHaveLength(1);
    expect(screen.getByTestId('gallery').textContent).toContain('Main gate');
  });

  it('a project that is not on the device', async () => {
    useRole('field_collector');
    navigate('/projects/00000000-0000-7000-8000-000000000000');
    render(<ProjectDetailsPage />);
    await screen.findByTestId('details-not-found');
  });
});

describe('opens in < 300 ms from local data (brief §5)', () => {
  it('with 1,000 projects on the device', async () => {
    await seedProject();
    const many = Array.from({ length: 1000 }, (_, i) =>
      serverProject({
        id: `00000000-0081-7000-8000-${String(i).padStart(12, '0')}`,
        name_ar: `مسجد ${i}`,
        lon: 39 + (i % 100) / 100,
        lat: -5 - Math.floor(i / 100) / 100,
      }),
    );
    await applyServerRows('projects', many);
    expect(await db.projects.count()).toBe(1001);
    useRole('country_manager');

    const t0 = performance.now();
    const details = await loadProjectDetails(P);
    const loadMs = performance.now() - t0;
    expect(details?.bundle.staff).toHaveLength(1);

    navigate(`/projects/${P}`);
    const t1 = performance.now();
    render(<ProjectDetailsPage />);
    await screen.findByTestId('details-staff');
    const openMs = performance.now() - t1;
    // Measured here: load ≈ 5 ms, full open ≈ 60 ms (happy-dom + fake-indexeddb).
    expect(loadMs, `loadProjectDetails took ${loadMs.toFixed(1)} ms`).toBeLessThan(300);
    expect(openMs, `the details card opened in ${openMs.toFixed(1)} ms`).toBeLessThan(300);
  });
});

describe('delete', () => {
  const cases: Array<[TestRole, string, Row<'projects'>['record_state'], boolean]> = [
    ['field_collector', USER_A, 'draft', true],
    ['field_collector', USER_A, 'returned', true],
    ['field_collector', USER_A, 'submitted', false],
    ['field_collector', USER_A, 'approved', false],
    ['field_collector', USER_B, 'draft', false],
    ['branch_supervisor', USER_B, 'approved', true],
    ['viewer', USER_A, 'draft', false],
  ];
  for (const [role, creator, state, allowed] of cases) {
    it(`${role} · ${creator === USER_A ? 'own' : 'other'} · ${state} → ${allowed ? 'offered' : 'hidden'}`, async () => {
      await seedProject({ created_by: creator, record_state: state });
      useRole(role);
      await openDetails();
      expect(!!screen.queryByTestId('details-delete')).toBe(allowed);
    });
  }

  it('asks first, then deletes softly and goes back to the register', async () => {
    await seedProject({ created_by: USER_A, record_state: 'draft' });
    useRole('field_collector');
    await openDetails();
    fireEvent.click(screen.getByTestId('details-delete'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(await db.projects.get(P)).toBeTruthy();

    fireEvent.click(screen.getByTestId('details-delete'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(window.location.pathname).toBe('/projects'));
    expect(await db.projects.get(P)).toBeUndefined();
    const ops = await db.outbox.toArray();
    expect(ops.some((o) => o.table === 'projects' && o.row_id === P && o.kind === 'delete')).toBe(
      true,
    );
  });
});

describe('review actions', () => {
  it('approve: record_state approved locally, queued, sync started', async () => {
    await seedProject({ record_state: 'submitted' });
    useRole('branch_supervisor');
    await openDetails();
    fireEvent.click(screen.getByTestId('review-approve'));
    await waitFor(async () => expect((await db.projects.get(P))?.record_state).toBe('approved'));
    const op = (await db.outbox.toArray()).find((o) => o.table === 'projects' && o.row_id === P);
    expect(op?.fields.record_state).toBe('approved');
    expect(op?.base_version).toBe(1);
    expect(syncMocks.syncNow).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('details-record-state').textContent).toBe('Approved'),
    );
  });

  it('return: needs a note; Esc never throws the typed note away', async () => {
    await seedProject({ record_state: 'submitted' });
    useRole('branch_supervisor');
    await openDetails();
    fireEvent.click(screen.getByTestId('review-return'));
    await screen.findByTestId('return-dialog');
    fireEvent.click(screen.getByTestId('return-confirm'));
    expect(await screen.findByText('Write a note saying what must be corrected')).toBeTruthy();
    expect((await db.projects.get(P))?.record_state).toBe('submitted');

    fireEvent.input(screen.getByTestId('return-note'), {
      target: { value: 'The location is wrong' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect((screen.getByTestId('return-note') as HTMLTextAreaElement).value).toBe(
      'The location is wrong',
    );

    fireEvent.click(screen.getByTestId('return-confirm'));
    await waitFor(async () => expect((await db.projects.get(P))?.record_state).toBe('returned'));
    expect((await db.projects.get(P))?.review_note).toBe('The location is wrong');
    await waitFor(() => expect(screen.queryByTestId('return-dialog')).toBeNull());
    expect(await screen.findByTestId('details-review-note')).toBeTruthy();
  });

  it('migration note (v2 salary-currency flag): shown, with the reviewer hint for reviewers only', async () => {
    await seedProject({
      record_state: 'submitted',
      migration_note: 'Salaries were given the currency TZS; check it',
    });
    useRole('branch_supervisor');
    await openDetails();
    const note = await screen.findByTestId('details-migration-note');
    expect(note.textContent).toContain('Migration note');
    expect(note.textContent).toContain('Salaries were given the currency TZS; check it');
    expect(screen.getByTestId('details-migration-note-hint')).toBeTruthy();
    cleanup();

    useRole('field_collector');
    await openDetails();
    expect((await screen.findByTestId('details-migration-note')).textContent).toContain('TZS');
    expect(screen.queryByTestId('details-migration-note-hint')).toBeNull();
  });

  it('no migration note → no notice (blank counts as none)', async () => {
    await seedProject({ record_state: 'submitted', migration_note: '  ' });
    useRole('branch_supervisor');
    await openDetails();
    expect(screen.queryByTestId('details-migration-note')).toBeNull();
  });

  it('a collector sees no review actions, but may submit his draft', async () => {
    await seedProject({ record_state: 'draft', created_by: USER_A });
    useRole('field_collector');
    await openDetails();
    expect(screen.queryByTestId('review-approve')).toBeNull();
    expect(screen.queryByTestId('review-return')).toBeNull();
    fireEvent.click(screen.getByTestId('details-submit'));
    await waitFor(async () => expect((await db.projects.get(P))?.record_state).toBe('submitted'));
  });
});

describe('maintenance history', () => {
  it('adds an entry and changes its state', async () => {
    await seedProject({ created_by: USER_A, record_state: 'draft' });
    useRole('field_collector');
    await openDetails();
    expect(screen.getAllByTestId('maintenance-entry')).toHaveLength(1);
    // The seeded entry was created by somebody else: a collector cannot change it.
    expect(screen.queryByTestId('maintenance-state-select')).toBeNull();

    fireEvent.click(screen.getByTestId('maintenance-add'));
    fireEvent.click(screen.getByTestId('maintenance-save'));
    expect(await screen.findByText('Describe the maintenance needed')).toBeTruthy();
    fireEvent.input(screen.getByTestId('maintenance-description'), {
      target: { value: 'Broken window' },
    });
    fireEvent.change(screen.getByTestId('maintenance-priority-input'), {
      target: { value: 'urgent' },
    });
    fireEvent.input(screen.getByTestId('maintenance-cost'), { target: { value: '120000' } });
    fireEvent.click(screen.getByTestId('maintenance-save'));
    await waitFor(() => expect(screen.getAllByTestId('maintenance-entry')).toHaveLength(2));
    const stored = (await db.project_maintenance.where('project_id').equals(P).toArray()).find(
      (m) => m.description === 'Broken window',
    )!;
    expect(stored.priority).toBe('urgent');
    expect(stored.estimated_cost).toBe(120000);
    expect(stored.currency).toBe('TZS');
    expect(stored.state).toBe('open');

    const select = await screen.findByTestId('maintenance-state-select');
    fireEvent.change(select, { target: { value: 'done' } });
    await waitFor(async () =>
      expect((await db.project_maintenance.get(stored.id))?.state).toBe('done'),
    );
    expect((await db.project_maintenance.get(stored.id))?.resolved_on).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    // the project record state is untouched (sync.md §4.3)
    expect((await db.projects.get(P))?.record_state).toBe('draft');
  });
});
