import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(async (_fn: string, _args?: Record<string, unknown>): Promise<unknown> => []),
  syncNow: vi.fn(async () => undefined),
  remoteNames: [] as Array<{ id: string; name_ar: string | null; name_latin: string | null }>,
}));

vi.mock('../auth', async () => {
  const { signal, computed } = await import('@preact/signals');
  const phone = await import('../auth/phone');
  const fixtures = await import('../auth/__fixtures__/myContext');
  const caps = signal({ write: true, review: false, seePeople: true, seeRestricted: false });
  return {
    me: signal(fixtures.collectorPemba),
    can: {
      write: computed(() => caps.value.write),
      review: computed(() => caps.value.review),
      seePeople: computed(() => caps.value.seePeople),
      seeRestricted: computed(() => caps.value.seeRestricted),
      admin: computed(() => false),
    },
    supabase: {
      from: () => ({
        select: () => ({
          in: async (_col: string, ids: string[]) => ({
            data: mocks.remoteNames.filter((r) => ids.includes(r.id)),
            error: null,
          }),
        }),
      }),
    },
    DIAL_COUNTRIES: phone.DIAL_COUNTRIES,
    __caps: caps,
  };
});

vi.mock('../sync', async () => {
  const errors = await import('../sync/errors');
  return {
    transport: { rpc: mocks.rpc },
    syncNow: mocks.syncNow,
    isSyncError: errors.isSyncError,
    SyncError: errors.SyncError,
  };
});

import * as auth from '../auth';
import * as fixtures from '../auth/__fixtures__/myContext';
import { applyServerRows, db } from '../db';
import { freshDb, outbox, serverProject, serverRow } from '../db/testing/factory';
import { t } from '../i18n';
import { navigate } from '../routes';
import { SyncError } from '../sync/errors';
import PeoplePage from './PeoplePage';
import { readAddPersonDraft } from './pickerDraft';

type Caps = { write: boolean; review: boolean; seePeople: boolean; seeRestricted: boolean };
const caps = (auth as unknown as { __caps: { value: Caps } }).__caps;

const TZ = 'e2a6484f-39a5-3135-816a-03ad934d99fd';
const PEMBA = '58372685-bb04-3409-b7fa-17b08890ee4a';
const P_MOHAMED = '0190b000-0000-7000-8000-000000000001';
const P_MOHAMMED = '0190b000-0000-7000-8000-000000000002';
const P_KHALID = '0190b000-0000-7000-8000-000000000003';
const P_GONE = '0190b000-0000-7000-8000-000000000009';
const PROJECT = '0190b000-0000-7000-8000-0000000000a1';
const STAFF = '0190b000-0000-7000-8000-0000000000b1';
const REQ_MERGED = '0190b000-0000-7000-8000-0000000000c1';
const REQ_PENDING = '0190b000-0000-7000-8000-0000000000c2';

function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
}

async function seed(opts: { restricted?: boolean } = {}): Promise<void> {
  await freshDb({ canSeeRestricted: opts.restricted ?? false });
  await applyServerRows('countries', [
    serverRow('countries', {
      id: TZ,
      iso2: 'TZ',
      iso3: 'TZA',
      name_ar: 'تنزانيا',
      name_en: 'Tanzania',
      active: true,
    }),
  ]);
  await applyServerRows('branches', [
    serverRow('branches', {
      id: PEMBA,
      country_id: TZ,
      code: 'PEMBA',
      name_ar: 'بيمبا',
      admin_area_ids: [],
      active: true,
    }),
  ]);
  await applyServerRows('persons', [
    serverRow('persons', {
      id: P_MOHAMED,
      name_ar: 'محمد علي',
      name_latin: 'Mohamed Ali',
      phone_e164: '+255711000102',
      country_id: TZ,
      branch_id: PEMBA,
    }),
    serverRow('persons', {
      id: P_MOHAMMED,
      name_ar: 'محمد على',
      name_latin: null,
      phone_e164: null,
      birth_year: 1985,
      country_id: TZ,
      branch_id: PEMBA,
    }),
    serverRow('persons', {
      id: P_KHALID,
      name_ar: 'خالد حسن',
      name_latin: 'Khalid Hassan',
      phone_e164: '+255711000103',
      country_id: TZ,
      branch_id: PEMBA,
    }),
  ]);
  await applyServerRows('projects', [
    serverProject({
      id: PROJECT,
      code: 'TZ-PN-000001',
      name_ar: 'مسجد النور',
      type: 'mosque',
      country_id: TZ,
      branch_id: PEMBA,
    }),
  ]);
  await applyServerRows('project_staff', [
    serverRow('project_staff', {
      id: STAFF,
      project_id: PROJECT,
      person_id: P_MOHAMED,
      role: 'imam',
      start_date: '2019-03-01',
      end_date: null,
    }),
  ]);
  if (opts.restricted) {
    await applyServerRows('staff_compensation', [
      serverRow('staff_compensation', {
        project_staff_id: STAFF,
        monthly_amount: 250000,
        currency: 'TZS',
        effective_from: '2024-01-01',
      }),
    ]);
  }
}

async function seedRequests(): Promise<void> {
  await applyServerRows('person_merge_requests', [
    serverRow('person_merge_requests', {
      id: REQ_MERGED,
      source_person_id: P_GONE,
      target_person_id: P_KHALID,
      state: 'merged',
      reason: 'الرقم نفسه',
      decided_at: '2026-10-01T10:00:00Z',
    }),
    serverRow('person_merge_requests', {
      id: REQ_PENDING,
      source_person_id: P_MOHAMMED,
      target_person_id: P_MOHAMED,
      state: 'pending',
      reason: 'اسم مكرر',
    }),
  ]);
}

function open(path = '/people'): void {
  navigate(path, { replace: true });
  render(<PeoplePage />);
}

const rows = () => screen.queryAllByTestId('person-row');
/** waitFor with room for a loaded machine (several IndexedDB reads per step). */
const slow = <T,>(check: () => T | Promise<T>) => waitFor(check, { timeout: 5000 });
const type = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } });

async function openCard(personId: string): Promise<HTMLElement> {
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));
  const row = rows().find((r) => r.dataset.personId === personId)!;
  fireEvent.click(row.parentElement!); // the virtual list row is the interactive unit
  return screen.findByTestId('person-card');
}

beforeEach(async () => {
  caps.value = { write: true, review: false, seePeople: true, seeRestricted: false };
  auth.me.value = fixtures.collectorPemba;
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue([]);
  mocks.syncNow.mockClear();
  mocks.remoteNames = [];
  setOnline(true);
  await seed();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('PeoplePage — access', () => {
  it('a viewer cannot open the page: no directory, no names', async () => {
    caps.value = { write: false, review: false, seePeople: false, seeRestricted: false };
    auth.me.value = fixtures.viewerGlobal;
    open();
    expect(screen.getByTestId('people-forbidden')).toBeTruthy();
    expect(screen.queryByTestId('people-page')).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('محمد علي')).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('collectors see the directory without the merge tools of reviewers', async () => {
    open();
    await openCard(P_MOHAMED);
    expect(screen.queryByTestId('people-tab-requests')).toBeNull();
    expect(screen.queryByTestId('person-merge')).toBeNull();
    expect(screen.getByTestId('person-request-merge')).toBeTruthy();
    expect(screen.getByTestId('person-edit')).toBeTruthy();
  });
});

describe('PeoplePage — directory and card', () => {
  it('lists people and searches the local index', async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    type(screen.getByTestId('search-input'), 'خالد');
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]!.dataset.personId).toBe(P_KHALID);
    type(screen.getByTestId('search-input'), '+255 711 000 102');
    await waitFor(() => expect(rows().map((r) => r.dataset.personId)).toEqual([P_MOHAMED]));
    // National format: the calling code of the user's country (Tanzania) is added.
    type(screen.getByTestId('search-input'), '0711 000 103');
    await waitFor(() => expect(rows().map((r) => r.dataset.personId)).toEqual([P_KHALID]));
    type(screen.getByTestId('search-input'), 'zzzz');
    expect(await screen.findByTestId('people-empty')).toBeTruthy();
  });

  it('the card shows assignments with role and dates, and no salary without restricted access', async () => {
    open();
    const card = await openCard(P_MOHAMED);
    const assignment = await within(card).findByTestId('person-assignment');
    expect(within(assignment).getByText('TZ-PN-000001')).toBeTruthy();
    expect(within(assignment).getByText(/إمام/)).toBeTruthy();
    expect(within(assignment).getByText(/2019/)).toBeTruthy();
    expect(within(card).queryByTestId('person-salary')).toBeNull();
    expect(within(card).queryByText(/250/)).toBeNull();
  });

  it('shows the current salary to restricted access (country manager / HQ)', async () => {
    await seed({ restricted: true });
    caps.value = { write: true, review: true, seePeople: true, seeRestricted: true };
    auth.me.value = fixtures.managerTzAal2;
    open();
    const card = await openCard(P_MOHAMED);
    const salary = await within(card).findByTestId('person-salary');
    expect(salary.textContent).toMatch(/250/);
  });

  it('edits a person through mutate() and Escape never discards typed changes', async () => {
    open();
    await openCard(P_KHALID);
    fireEvent.click(screen.getByTestId('person-edit'));
    const latin = (await screen.findByTestId('person-edit-name-latin')) as HTMLInputElement;
    expect(latin.value).toBe('Khalid Hassan');
    type(latin, 'Khalid Hassan Said');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await screen.findByTestId('confirm-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect((screen.getByTestId('person-edit-name-latin') as HTMLInputElement).value).toBe(
      'Khalid Hassan Said',
    );

    fireEvent.click(screen.getByTestId('person-edit-save'));
    await waitFor(() => expect(screen.queryByTestId('person-edit-dialog')).toBeNull());
    const ops = await outbox();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      table: 'persons',
      row_id: P_KHALID,
      kind: 'upsert',
      base_version: 1,
    });
    expect(ops[0]!.fields).toEqual({ name_latin: 'Khalid Hassan Said' });
    expect((await db.persons.get(P_KHALID))!.name_latin).toBe('Khalid Hassan Said');
    // The directory follows the change without a reload.
    await waitFor(() =>
      expect(rows().find((r) => r.dataset.personId === P_KHALID)!.textContent).toContain(
        'Khalid Hassan Said',
      ),
    );
  });

  it('"add person" goes through the duplicate-aware picker and creates the row', async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(screen.getByTestId('people-add'));
    const input = await screen.findByTestId('people-add-picker-input');
    type(input, 'سالم خميس');
    fireEvent.click(await screen.findByTestId('people-add-picker-new'));
    await screen.findByTestId('people-add-picker-new-name-ar');
    type(screen.getByTestId('people-add-picker-new-education'), 'ثانوي');

    // Escape with typed data asks first and keeps everything when the user cancels.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(screen.getByTestId('people-add-dialog')).toBeTruthy();
    expect((screen.getByTestId('people-add-picker-new-education') as HTMLInputElement).value).toBe(
      'ثانوي',
    );

    fireEvent.click(screen.getByTestId('people-add-picker-new-confirm'));
    await waitFor(() => expect(screen.queryByTestId('people-add-dialog')).toBeNull());
    const ops = await outbox();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ table: 'persons', kind: 'upsert', base_version: 0 });
    expect(await screen.findByTestId('person-card')).toBeTruthy();
    await waitFor(() => expect(rows()).toHaveLength(4));
  });
});

describe('PeoplePage — searched lists continue in keyset pages (brief §5)', () => {
  const count = () => screen.getByTestId('people-count');
  /** Scrolls the virtual list to the end of what it shows (76 px rows). */
  const scrollToEnd = (shown: number) => {
    const list = screen.getByTestId('people-list');
    list.scrollTop = shown * 76 - 600;
    fireEvent.scroll(list);
  };

  beforeEach(async () => {
    const people = [];
    for (let i = 0; i < 120; i++) {
      const n = String(i).padStart(3, '0');
      people.push(
        serverRow('persons', {
          id: `0190b000-0000-7000-8000-000000001${n}`,
          name_ar: `محمد سالم ${n}`,
          name_latin: `Mohamed Salim ${n}`,
          phone_e164: null,
          country_id: TZ,
        }),
      );
    }
    await applyServerRows('persons', people);
  });

  it('120 matches: says how many exist and loads the rest while scrolling', async () => {
    open();
    type(screen.getByTestId('search-input'), 'Salim');
    await slow(() => expect(count().dataset.total).toBe('120'));
    expect(count().dataset.shown).toBe('50');
    expect(count().textContent).toContain('50');
    expect(count().textContent).toContain('120');
    expect(count().textContent).toBe(t('people.resultsCountOf', { count: '50', total: '120' }));

    scrollToEnd(50);
    await slow(() => expect(count().dataset.shown).toBe('100'));
    scrollToEnd(100);
    await slow(() => expect(count().dataset.shown).toBe('120'));
    // Everything is shown: the plain counter again, and the last match is in the list.
    expect(count().textContent).toBe(t('people.resultsCount', { count: '120' }));
    scrollToEnd(120);
    await waitFor(() =>
      expect(
        rows().some((r) => r.dataset.personId === '0190b000-0000-7000-8000-000000001119'),
      ).toBe(true),
    );
  });

  it('a one-letter query does not filter yet and still pages', async () => {
    open();
    type(screen.getByTestId('search-input'), 'M');
    await slow(() => expect(count().dataset.shown).toBe('50'));
    scrollToEnd(50);
    await slow(() => expect(count().dataset.shown).toBe('100'));
  });

  it('pages again after the query changed and after a live change of the rows', async () => {
    open();
    await slow(() => expect(count().dataset.shown).toBe('50'));
    scrollToEnd(50);
    await slow(() => expect(count().dataset.shown).toBe('100'));
    // A new query starts again at one page — and can still grow.
    type(screen.getByTestId('search-input'), 'Salim');
    await slow(() => expect(count().dataset.total).toBe('120'));
    expect(count().dataset.shown).toBe('50');
    scrollToEnd(50);
    await slow(() => expect(count().dataset.shown).toBe('100'));
    // A pull that changes a person on screen keeps the pages already loaded.
    await applyServerRows('persons', [
      serverRow('persons', {
        id: '0190b000-0000-7000-8000-000000001045',
        name_ar: 'محمد سالم 045',
        name_latin: 'Mohamed Salim 045 Wete',
        country_id: TZ,
        version: 2,
      }),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId('people-list').textContent).toContain('Mohamed Salim 045 Wete'),
    );
    expect(count().dataset.shown).toBe('100');
    scrollToEnd(100);
    await slow(() => expect(count().dataset.shown).toBe('120'));
  });
});

describe('PeoplePage — an unfinished "add person" survives Back and reload (brief §7.4)', () => {
  async function typeNewPerson(): Promise<void> {
    fireEvent.click(screen.getByTestId('people-add'));
    type(await screen.findByTestId('people-add-picker-input'), 'حمدان بن راشد');
    fireEvent.click(await screen.findByTestId('people-add-picker-new'));
    type(await screen.findByTestId('people-add-picker-new-name-latin'), 'Hamdan bin Rashid');
    type(screen.getByTestId('people-add-picker-new-birth-year'), '1979');
    // Every change is written to the device; wait for the last one.
    await waitFor(async () => expect((await readAddPersonDraft())?.form?.birth_year).toBe('1979'), {
      timeout: 5000,
    });
  }

  it('is restored when the dialog opens again after the page was left', async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    await typeNewPerson();

    // Back / reload: the page goes away without the dialog being closed.
    cleanup();
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(screen.getByTestId('people-add'));
    expect(
      await screen.findByTestId('people-add-restored', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(
      ((await screen.findByTestId('people-add-picker-new-name-ar')) as HTMLInputElement).value,
    ).toBe('حمدان بن راشد');
    expect((screen.getByTestId('people-add-picker-new-name-latin') as HTMLInputElement).value).toBe(
      'Hamdan bin Rashid',
    );
    expect((screen.getByTestId('people-add-picker-new-birth-year') as HTMLInputElement).value).toBe(
      '1979',
    );

    // Creating the person forgets the draft.
    fireEvent.click(screen.getByTestId('people-add-picker-new-confirm'));
    await waitFor(() => expect(screen.queryByTestId('people-add-dialog')).toBeNull());
    await slow(async () => expect(await readAddPersonDraft()).toBeNull());
    const [op] = await outbox();
    expect(op!.fields).toMatchObject({ name_ar: 'حمدان بن راشد', birth_year: 1979 });
  });

  it('a confirmed discard forgets it: the next opening starts empty', async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    await typeNewPerson();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(screen.queryByTestId('people-add-dialog')).toBeNull());
    // Reopened at once: the discard is applied before the stored draft is read.
    fireEvent.click(screen.getByTestId('people-add'));
    const input = (await screen.findByTestId('people-add-picker-input', undefined, {
      timeout: 5000,
    })) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(screen.queryByTestId('people-add-restored')).toBeNull();
    expect(await readAddPersonDraft()).toBeNull();
  });
});

describe('PeoplePage — merging (manual, undoable)', () => {
  beforeEach(() => {
    caps.value = { write: true, review: true, seePeople: true, seeRestricted: false };
    auth.me.value = fixtures.supervisorPemba;
  });

  it('a reviewer merges with merge_persons after comparing both sides, then syncs', async () => {
    mocks.rpc.mockImplementation(async (fn: string) =>
      fn === 'merge_persons'
        ? {
            request_id: 'r1',
            state: 'merged',
            source_id: P_MOHAMMED,
            target_id: P_MOHAMED,
            moved_staff: 0,
            collapsed_staff: 0,
            filled_fields: ['birth_year'],
          }
        : [],
    );
    open();
    await openCard(P_MOHAMMED);
    fireEvent.click(screen.getByTestId('person-merge'));
    const dialog = await screen.findByTestId('merge-dialog');
    await waitFor(() =>
      expect(within(dialog).getByTestId('merge-source-selected').dataset.personId).toBe(P_MOHAMMED),
    );

    // The possible duplicate is suggested; choosing it fills the target.
    const suggestion = await within(dialog).findByTestId('merge-suggestion');
    expect(suggestion.dataset.personId).toBe(P_MOHAMED);
    fireEvent.click(suggestion);
    const compare = await within(dialog).findByTestId('merge-compare');
    // birth_year is blank in the target and present in the source: it will be filled.
    expect(within(compare).getByText(/سيُكمَل من الشخص المكرر/)).toBeTruthy();

    // A reason is required.
    fireEvent.click(within(dialog).getByTestId('merge-submit'));
    expect(await within(dialog).findByText(/اكتب سبب الدمج/)).toBeTruthy();
    expect(mocks.rpc).not.toHaveBeenCalledWith('merge_persons', expect.anything());

    type(within(dialog).getByTestId('merge-reason'), 'الاسم نفسه بإملاء مختلف');
    fireEvent.click(within(dialog).getByTestId('merge-submit'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('merge_persons', {
        p_source: P_MOHAMMED,
        p_target: P_MOHAMED,
        p_reason: 'الاسم نفسه بإملاء مختلف',
      }),
    );
    await waitFor(() => expect(mocks.syncNow).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('merge-dialog')).toBeNull());
    expect(window.location.search).toContain(P_MOHAMED);
    // Nothing was merged on the device by the client itself.
    expect(await outbox()).toHaveLength(0);
  });

  it('cancelling the confirmation calls nothing', async () => {
    open();
    await openCard(P_MOHAMMED);
    fireEvent.click(screen.getByTestId('person-merge'));
    const dialog = await screen.findByTestId('merge-dialog');
    fireEvent.click(await within(dialog).findByTestId('merge-suggestion'));
    type(within(dialog).getByTestId('merge-reason'), 'سبب كاف');
    fireEvent.click(within(dialog).getByTestId('merge-submit'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.rpc).not.toHaveBeenCalledWith('merge_persons', expect.anything());
    expect(mocks.syncNow).not.toHaveBeenCalled();
  });

  it('shows the server refusal next to the form', async () => {
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'merge_persons')
        throw new SyncError('conflict', 'merge_persons: person_already_merged', {
          status: 409,
          code: 'PT409',
        });
      return [];
    });
    open();
    await openCard(P_MOHAMMED);
    fireEvent.click(screen.getByTestId('person-merge'));
    const dialog = await screen.findByTestId('merge-dialog');
    fireEvent.click(await within(dialog).findByTestId('merge-suggestion'));
    type(within(dialog).getByTestId('merge-reason'), 'سبب كاف');
    fireEvent.click(within(dialog).getByTestId('merge-submit'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    const error = await within(dialog).findByTestId('merge-error');
    expect(error.textContent).toMatch(/مدموج أو محذوف/);
    expect(mocks.syncNow).not.toHaveBeenCalled();
  });

  it('needs a connection: the merge button is disabled offline', async () => {
    setOnline(false);
    open();
    await openCard(P_MOHAMMED);
    fireEvent.click(screen.getByTestId('person-merge'));
    const dialog = await screen.findByTestId('merge-dialog');
    expect((within(dialog).getByTestId('merge-submit') as HTMLButtonElement).disabled).toBe(true);
    setOnline(true);
  });

  it('lower roles propose with request_person_merge instead (no merge, no confirmation)', async () => {
    caps.value = { write: true, review: false, seePeople: true, seeRestricted: false };
    auth.me.value = fixtures.collectorPemba;
    mocks.rpc.mockImplementation(async (fn: string) =>
      fn === 'request_person_merge' ? { request_id: 'q1', state: 'pending', created: true } : [],
    );
    open();
    await openCard(P_MOHAMMED);
    fireEvent.click(screen.getByTestId('person-request-merge'));
    const dialog = await screen.findByTestId('merge-dialog');
    const targetInput = within(dialog).getByTestId('merge-target-input');
    type(targetInput, 'خالد');
    fireEvent.click(await within(dialog).findByTestId('merge-target-option'));
    type(within(dialog).getByTestId('merge-reason'), 'نفس الشخص');
    fireEvent.click(within(dialog).getByTestId('merge-submit'));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('request_person_merge', {
        p_source: P_MOHAMMED,
        p_target: P_KHALID,
        p_reason: 'نفس الشخص',
      }),
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith('merge_persons', expect.anything());
    await waitFor(() => expect(mocks.syncNow).toHaveBeenCalled());
  });

  it('the merge trail lists requests; "undo" calls revert_person_merge and syncs', async () => {
    await seedRequests();
    mocks.remoteNames = [{ id: P_GONE, name_ar: 'خالد حسين', name_latin: null }];
    mocks.rpc.mockImplementation(async (fn: string) =>
      fn === 'revert_person_merge'
        ? {
            request_id: REQ_MERGED,
            state: 'reverted',
            source_id: P_GONE,
            target_id: P_KHALID,
            restored_staff: 2,
            skipped_staff: 0,
            restored_collapsed: 0,
            reset_fields: [],
          }
        : [],
    );
    open('/people?tab=requests');
    const tab = await screen.findByTestId('people-tab-requests');
    expect(tab.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(screen.getAllByTestId('merge-request-row')).toHaveLength(2));
    const [first, second] = screen.getAllByTestId('merge-request-row');
    expect(first!.dataset.state).toBe('pending'); // pending first
    // The merged duplicate is no longer on the device: its name comes from the server.
    await waitFor(() => expect(second!.textContent).toContain('خالد حسين'));

    fireEvent.click(within(second!).getByTestId('merge-revert'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('revert_person_merge', { p_request_id: REQ_MERGED }),
    );
    await waitFor(() => expect(mocks.syncNow).toHaveBeenCalled());
  });

  it('a pending request is reviewed side by side and approved through resolve_person_merge_request', async () => {
    await seedRequests();
    mocks.rpc.mockImplementation(async (fn: string) =>
      fn === 'resolve_person_merge_request'
        ? {
            request_id: REQ_PENDING,
            state: 'merged',
            source_id: P_MOHAMMED,
            target_id: P_MOHAMED,
            moved_staff: 0,
            collapsed_staff: 0,
            filled_fields: [],
          }
        : [],
    );
    open('/people?tab=requests');
    await waitFor(() => expect(screen.getAllByTestId('merge-request-row')).toHaveLength(2));
    fireEvent.click(screen.getByTestId('merge-review'));
    const dialog = await screen.findByTestId('merge-dialog');
    await within(dialog).findByTestId('merge-compare');
    expect(within(dialog).getByTestId('merge-request-reason').textContent).toContain('اسم مكرر');
    fireEvent.click(within(dialog).getByTestId('merge-approve'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('resolve_person_merge_request', {
        p_request_id: REQ_PENDING,
        p_decision: 'approve',
        p_note: null,
      }),
    );
    await waitFor(() => expect(mocks.syncNow).toHaveBeenCalled());
  });

  it('a pending request can be rejected with a note', async () => {
    await seedRequests();
    mocks.rpc.mockImplementation(async (fn: string) =>
      fn === 'resolve_person_merge_request'
        ? {
            request_id: REQ_PENDING,
            state: 'rejected',
            source_id: P_MOHAMMED,
            target_id: P_MOHAMED,
          }
        : [],
    );
    open('/people?tab=requests');
    await waitFor(() => expect(screen.getAllByTestId('merge-request-row')).toHaveLength(2));
    fireEvent.click(screen.getByTestId('merge-review'));
    const dialog = await screen.findByTestId('merge-dialog');
    await within(dialog).findByTestId('merge-compare');
    type(within(dialog).getByTestId('merge-note'), 'شخصان مختلفان');
    fireEvent.click(within(dialog).getByTestId('merge-reject'));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('resolve_person_merge_request', {
        p_request_id: REQ_PENDING,
        p_decision: 'reject',
        p_note: 'شخصان مختلفان',
      }),
    );
    await waitFor(() => expect(mocks.syncNow).toHaveBeenCalled());
  });

  it('collectors never see the merge trail tab, even through the URL', async () => {
    caps.value = { write: true, review: false, seePeople: true, seeRestricted: false };
    await seedRequests();
    open('/people?tab=requests');
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(screen.queryByTestId('people-tab-requests')).toBeNull();
    expect(screen.queryByTestId('merge-request-row')).toBeNull();
  });
});
