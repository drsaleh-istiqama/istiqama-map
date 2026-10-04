import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

import { applyServerRows, STD_SERVER_COLUMNS, SYNC_TABLES, type Row } from '../db';
import { freshDb, serverProject, serverRow, USER_B } from '../db/testing/factory';
import { hasTranslation, setLocale, type Locale } from '../i18n';
import { clearViewFilters } from '../routes';
import { columnLabel, formatConflictValue } from './ConflictsPanel';
import { conflictReferences, type NamedRow } from './queries';
import ReviewPage from './ReviewPage';
import { resetSyncMocks, useRole } from './testkit';

const P1 = '00000000-0080-7000-8000-0000000000c1';
const OPT1 = '0190a000-0000-7000-8000-000000000001';
const OPT2 = '0190a000-0000-7000-8000-000000000002';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Every column a device can write, i.e. every field a `sync_conflicts` row can name
 * (sync.md §4.2: an update of a client-writable table; server-managed and parent columns
 * never conflict; a point is reported as `geom`).
 */
function conflictableColumns(): Set<string> {
  const std = new Set<string>(STD_SERVER_COLUMNS);
  const out = new Set<string>(['geom']);
  for (const def of SYNC_TABLES) {
    if (def.push.update === 'none' && def.push.insert === 'none') continue;
    const blocked = new Set([...def.protectedCols, ...def.immutableCols]);
    for (const col of def.writableCols ?? def.columns) {
      if (!std.has(col) && !blocked.has(col)) out.add(col);
    }
  }
  return out;
}

beforeEach(async () => {
  await freshDb({ canSeeRestricted: true });
  clearViewFilters();
  resetSyncMocks();
  useRole('country_manager');
});
afterEach(async () => {
  cleanup();
  document.body.innerHTML = '';
  await setLocale('en');
});

describe('conflict review: field names in words (brief §8)', () => {
  it.each<Locale>(['ar', 'sw', 'en'])(
    'every column of the synced tables has a translated name (%s)',
    async (l) => {
      await setLocale(l);
      const columns = [...conflictableColumns()];
      // projects, land, facilities, maintenance, photos, donors, people, staff, community…
      expect(columns.length).toBeGreaterThan(90);
      const untranslated = columns.filter(
        (c) => !hasTranslation(`projects.col_${c}`) || columnLabel(c) === c,
      );
      expect(untranslated).toEqual([]);
    },
  );

  it('the reported columns read as words in Arabic', async () => {
    await setLocale('ar');
    expect(columnLabel('teacher_housing')).toBe('سكن المعلمين');
    expect(columnLabel('daawa_activities')).toBe('الأنشطة الدعوية');
    expect(columnLabel('person_id')).toBe('الشخص');
    expect(columnLabel('home_admin_area_id')).toBe('منطقة السكن');
  });
});

describe('conflict review: values in words (brief §8)', () => {
  const refs = new Map<string, NamedRow>([
    [OPT1, { name_ar: 'حلقات تحفيظ', name_en: 'Qur’an circles', name_sw: 'Madrasa za Qur’ani' }],
    [OPT2, { name_ar: 'دروس أسبوعية', name_en: 'Weekly lessons', name_sw: 'Darsa za kila wiki' }],
  ]);

  it('option-list ids become option names joined with the language separator', async () => {
    await setLocale('ar');
    expect(formatConflictValue('daawa_activities', [OPT1, OPT2], { refs })).toBe(
      'حلقات تحفيظ، دروس أسبوعية',
    );
    await setLocale('en');
    expect(formatConflictValue('daawa_activities', [OPT1, OPT2], { refs })).toBe(
      'Qur’an circles, Weekly lessons',
    );
    await setLocale('sw');
    expect(formatConflictValue('daawa_activities', [OPT1, OPT2], { refs })).toBe(
      'Madrasa za Qur’ani, Darsa za kila wiki',
    );
  });

  it('never shows a raw id: an option that is not on the device is said so', async () => {
    await setLocale('en');
    const text = formatConflictValue(
      'livelihoods',
      [OPT1, '0190a000-0000-7000-8000-0000000000ff'],
      {
        refs,
      },
    );
    expect(text).toBe('Qur’an circles, (not on this device)');
    expect(text).not.toMatch(UUID);
    expect(formatConflictValue('person_id', OPT2, {})).toBe('(not on this device)');
    expect(formatConflictValue('daawa_activities', [], { refs })).toBe('(empty)');
  });

  it('table-specific codes, photo types, dates and numbers', async () => {
    await setLocale('en');
    expect(formatConflictValue('status', 'approved', { table: 'localities' })).toBe('Approved');
    expect(formatConflictValue('status', 'maintenance', { table: 'projects' })).toBe(
      'Needs maintenance',
    );
    expect(formatConflictValue('state', 'merged', { table: 'person_merge_requests' })).toBe(
      'Merged',
    );
    expect(formatConflictValue('upload_state', 'pending', { table: 'project_photos' })).toBe(
      'Waiting for upload',
    );
    expect(formatConflictValue('category', 'mosque_front')).not.toBe('mosque_front');
    expect(formatConflictValue('reported_on', '2026-08-03')).toBe('3 Aug 2026');
    expect(formatConflictValue('hall_capacity', 1200)).toBe('1,200');
    await setLocale('ar');
    expect(formatConflictValue('status', 'proposed', { table: 'localities' })).toBe('مقترحة');
  });

  it('conflictReferences reads the named rows of option lists, people, donors and areas', async () => {
    const person = serverRow('persons', { name_ar: 'سالم الحارثي', name_latin: 'Salim' });
    const donor = serverRow('donors', { name_ar: 'محسن كريم', name_latin: 'Generous donor' });
    await applyServerRows('option_values', [
      serverRow('option_values', {
        id: OPT1,
        list_key: 'daawa_activities',
        code: 'circles',
        name_ar: 'حلقات تحفيظ',
        name_en: 'Qur’an circles',
        name_sw: 'Madrasa za Qur’ani',
      }),
    ]);
    await applyServerRows('persons', [person]);
    await applyServerRows('donors', [donor]);
    const found = await conflictReferences([
      { field: 'daawa_activities', server_value: [OPT1], client_value: [OPT1, OPT2] },
      { field: 'person_id', server_value: person.id, client_value: null },
      { field: 'donor_id', server_value: null, client_value: donor.id },
      { field: 'builder', server_value: 'x', client_value: 'y' },
    ]);
    expect(found.get(OPT1)?.name_ar).toBe('حلقات تحفيظ');
    expect(found.get(person.id)?.name_ar).toBe('سالم الحارثي');
    expect(found.get(donor.id)?.name_latin).toBe('Generous donor');
    expect(found.has(OPT2)).toBe(false);
  });

  it('the review tab shows the field name and the option names, never ids (Arabic)', async () => {
    await setLocale('ar');
    await applyServerRows('projects', [serverProject({ id: P1, name_ar: 'مسجد النور' })]);
    await applyServerRows('option_values', [
      serverRow('option_values', {
        id: OPT1,
        list_key: 'daawa_activities',
        code: 'circles',
        name_ar: 'حلقات تحفيظ',
        name_en: 'Qur’an circles',
        name_sw: 'Madrasa za Qur’ani',
      }),
      serverRow('option_values', {
        id: OPT2,
        list_key: 'daawa_activities',
        code: 'weekly',
        name_ar: 'دروس أسبوعية',
        name_en: 'Weekly lessons',
        name_sw: 'Darsa za kila wiki',
      }),
    ]);
    const profile = serverRow('community_profiles', { project_id: P1 });
    await applyServerRows('sync_conflicts', [
      serverRow('sync_conflicts', {
        table_name: 'community_profiles',
        row_id: profile.id,
        project_id: P1,
        field: 'daawa_activities',
        base_version: 1,
        server_value: [OPT1] as unknown as Row<'sync_conflicts'>['server_value'],
        client_value: [OPT1, OPT2] as unknown as Row<'sync_conflicts'>['client_value'],
        client_user_id: USER_B,
        state: 'open',
      }),
    ]);
    render(<ReviewPage />);
    fireEvent.click(screen.getByTestId('review-tab-conflicts'));
    const row = await screen.findByTestId('conflict-row');
    expect(row.textContent).toContain('الأنشطة الدعوية');
    expect(row.textContent).not.toContain('daawa_activities');
    expect(within(row).getByTestId('conflict-server-value').textContent).toContain('حلقات تحفيظ');
    await within(row).findByText('حلقات تحفيظ، دروس أسبوعية');
    expect(row.textContent).not.toMatch(UUID);
  });
});
