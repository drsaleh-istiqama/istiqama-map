import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(async (_fn: string, _args?: Record<string, unknown>): Promise<unknown> => []),
  syncNow: vi.fn(async () => undefined),
}));

vi.mock('../auth', async () => {
  const { signal, computed } = await import('@preact/signals');
  const phone = await import('../auth/phone');
  const fixtures = await import('../auth/__fixtures__/myContext');
  const me = signal(fixtures.collectorPemba);
  return {
    me,
    can: {
      write: computed(() => true),
      review: computed(() => false),
      seePeople: computed(() => true),
      seeRestricted: computed(() => false),
      admin: computed(() => false),
    },
    supabase: {},
    DIAL_COUNTRIES: phone.DIAL_COUNTRIES,
  };
});

vi.mock('../sync', async () => {
  const errors = await import('../sync/errors');
  return {
    transport: { rpc: mocks.rpc },
    syncNow: mocks.syncNow,
    isSyncError: errors.isSyncError,
  };
});

import { me } from '../auth';
import * as fixtures from '../auth/__fixtures__/myContext';
import { applyServerRows, db, type Row } from '../db';
import { freshDb, outbox, serverRow } from '../db/testing/factory';
import PersonPicker, { type PersonPickerDraft, type PersonSelection } from './PersonPicker';

const TZ = 'e2a6484f-39a5-3135-816a-03ad934d99fd';
const PEMBA = '58372685-bb04-3409-b7fa-17b08890ee4a';
const P_MOHAMED = '0190a000-0000-7000-8000-000000000001';
const P_KHALID = '0190a000-0000-7000-8000-000000000002';

function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
}

async function seed(): Promise<void> {
  await freshDb();
  await applyServerRows('countries', [
    serverRow('countries', {
      id: TZ,
      iso2: 'TZ',
      iso3: 'TZA',
      name_ar: 'تنزانيا',
      name_en: 'Tanzania',
      name_sw: 'Tanzania',
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
      id: P_KHALID,
      name_ar: 'خالد حسن',
      name_latin: 'Khalid Hassan',
      phone_e164: '+255711000103',
      country_id: TZ,
      branch_id: PEMBA,
    }),
  ]);
}

function renderPicker(props: Partial<Parameters<typeof PersonPicker>[0]> = {}) {
  const onChange = vi.fn((_sel: PersonSelection) => undefined);
  const utils = render(<PersonPicker value={null} onChange={onChange} {...props} />);
  return { onChange, ...utils };
}

const input = () => screen.getByTestId('person-picker-input') as HTMLInputElement;
const type = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } });
/** The calling code of the user's country is read from the device asynchronously. */
const dialReady = () =>
  waitFor(() =>
    expect((screen.getByTestId('person-picker-new-dial') as HTMLSelectElement).value).toBe('255'),
  );

beforeEach(async () => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue([]);
  mocks.syncNow.mockClear();
  me.value = fixtures.collectorPemba;
  setOnline(true);
  await seed();
});

afterEach(() => {
  cleanup();
  setOnline(true);
});

describe('PersonPicker — possible matching people', () => {
  it('lists local candidates for a typed name and never chooses or merges by itself', async () => {
    const { onChange } = renderPicker();
    type(input(), 'محمد علي');
    const option = await screen.findByTestId('person-picker-candidate');
    expect(option.dataset.personId).toBe(P_MOHAMED);
    expect(within(option).getByText('+255711000102')).toBeTruthy();

    // Exact match, list open: still nothing is selected and nothing is written.
    expect(input().getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.keyDown(input(), { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 50));
    expect(onChange).not.toHaveBeenCalled();
    expect(await outbox()).toHaveLength(0);
    expect(await db.persons.count()).toBe(2);
    expect(await db.person_merge_requests.count()).toBe(0);
    // The only server call is the read-only candidates lookup.
    for (const [fn] of mocks.rpc.mock.calls) expect(fn).toBe('person_candidates');
  });

  it('asks the server when online, with phone and area, and shows masked phones as masked', async () => {
    mocks.rpc.mockResolvedValue([
      {
        id: 'srv-1',
        name_ar: 'محمد علي سالم',
        name_latin: null,
        phone: '+255 *** *** 777',
        phone_masked: true,
        gender: 'male',
        birth_year: 1980,
        home_area: { id: 'a1', name_ar: 'ويتي', name_en: 'Wete', name_sw: 'Wete', text: null },
        roles: ['teacher'],
        staff: [
          {
            project_staff_id: 'ps1',
            project_id: 'pr1',
            project_code: 'TZ-PN-000009',
            project_name_ar: 'مدرسة النور',
            project_name_latin: null,
            project_type: 'school',
            role: 'teacher',
            start_date: '2021-01-01',
            end_date: null,
          },
        ],
        hidden_projects: 1,
        similarity: 0.82,
        same_area: true,
        reasons: ['name', 'area'],
      },
    ]);
    renderPicker({ adminAreaId: 'area-x' });
    type(input(), 'محمد علي');
    await waitFor(() => expect(screen.getAllByTestId('person-picker-candidate')).toHaveLength(2));
    expect(mocks.rpc).toHaveBeenCalledWith('person_candidates', {
      p_name: 'محمد علي',
      p_phone: null,
      p_admin_area_id: 'area-x',
    });
    const remote = screen
      .getAllByTestId('person-picker-candidate')
      .find((o) => o.dataset.personId === 'srv-1')!;
    // Same area ranks first; the masked phone is shown as the server sent it, flagged hidden.
    expect(screen.getAllByTestId('person-picker-candidate')[0]).toBe(remote);
    expect(within(remote).getByText('+255 *** *** 777')).toBeTruthy();
    expect(within(remote).getByText('مخفي')).toBeTruthy();
    expect(within(remote).getByText('TZ-PN-000009')).toBeTruthy();
  });

  it('searches by phone number in the user’s country format', async () => {
    renderPicker();
    type(input(), '0711 000 103');
    const option = await screen.findByTestId('person-picker-candidate');
    expect(option.dataset.personId).toBe(P_KHALID);
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('person_candidates', {
        p_name: '',
        p_phone: '+255711000103',
        p_admin_area_id: null,
      }),
    );
  });

  it('does not call the server while offline and says so', async () => {
    setOnline(false);
    renderPicker();
    type(input(), 'محمد علي');
    await screen.findByTestId('person-picker-candidate');
    expect(await screen.findByTestId('person-picker-server-note')).toBeTruthy();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('keeps the local list when the server fails', async () => {
    mocks.rpc.mockRejectedValue(new Error('boom'));
    renderPicker();
    type(input(), 'محمد علي');
    await screen.findByTestId('person-picker-server-note');
    expect(screen.getAllByTestId('person-picker-candidate')).toHaveLength(1);
  });
});

describe('PersonPicker — explicit choices', () => {
  it('"same person" by click answers { personId }', async () => {
    const { onChange } = renderPicker();
    type(input(), 'محمد علي');
    fireEvent.click(await screen.findByTestId('person-picker-candidate'));
    expect(onChange).toHaveBeenCalledWith({ personId: P_MOHAMED });
    expect(await screen.findByTestId('person-picker-selected')).toBeTruthy();
    expect(await outbox()).toHaveLength(0);
  });

  it('is a keyboard combobox: arrows move aria-activedescendant, Enter chooses', async () => {
    const { onChange } = renderPicker();
    type(input(), 'محمد علي');
    const option = await screen.findByTestId('person-picker-candidate');
    expect(input().getAttribute('role')).toBe('combobox');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input().getAttribute('aria-activedescendant')).toBe(option.id);
    expect(option.getAttribute('aria-selected')).toBe('true');
    // ArrowDown again reaches "new person", ArrowUp comes back.
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input().getAttribute('aria-activedescendant')).toBe(
      screen.getByTestId('person-picker-new').id,
    );
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ personId: P_MOHAMED });
  });

  it('Escape closes the list without choosing', async () => {
    const { onChange } = renderPicker();
    type(input(), 'محمد علي');
    await screen.findByTestId('person-picker-candidate');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('"new person" answers { newPerson } with the phone in E.164 of the user’s country and writes nothing', async () => {
    const { onChange } = renderPicker({ role: 'imam' });
    type(input(), 'سالم خميس');
    fireEvent.click(await screen.findByTestId('person-picker-new'));
    const nameAr = (await screen.findByTestId('person-picker-new-name-ar')) as HTMLInputElement;
    expect(nameAr.value).toBe('سالم خميس');
    await dialReady();
    type(screen.getByTestId('person-picker-new-name-latin'), 'Salim Khamis');
    type(screen.getByTestId('person-picker-new-phone'), '0777 123 456');
    fireEvent.change(screen.getByTestId('person-picker-new-gender'), { target: { value: 'male' } });
    type(screen.getByTestId('person-picker-new-birth-year'), '1981');
    type(screen.getByTestId('person-picker-new-education'), 'ثانوي');
    type(screen.getByTestId('person-picker-new-graduated'), 'معهد القرآن');
    fireEvent.click(screen.getByTestId('person-picker-new-confirm'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledWith({
      newPerson: {
        name_ar: 'سالم خميس',
        name_latin: 'Salim Khamis',
        phone_e164: '+255777123456',
        gender: 'male',
        birth_year: 1981,
        education_level: 'ثانوي',
        graduated_from: 'معهد القرآن',
      },
    });
    expect(await outbox()).toHaveLength(0);
    expect(await db.persons.count()).toBe(2);
    expect(screen.getByTestId('person-picker-selected')).toBeTruthy();
  });

  it('with `persist`, "new person" creates a person row (outbox insert) and answers { personId }', async () => {
    const { onChange } = renderPicker({ persist: true });
    type(input(), 'سالم خميس');
    fireEvent.click(await screen.findByTestId('person-picker-new'));
    await screen.findByTestId('person-picker-new-name-ar');
    await dialReady();
    type(screen.getByTestId('person-picker-new-phone'), '0777123456');
    fireEvent.click(screen.getByTestId('person-picker-new-confirm'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const sel = onChange.mock.calls[0]![0] as { personId: string };
    const row = (await db.persons.get(sel.personId)) as Row<'persons'>;
    expect(row.name_ar).toBe('سالم خميس');
    expect(row.phone_e164).toBe('+255777123456');
    expect(row.version).toBe(0);
    const ops = await outbox();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      table: 'persons',
      row_id: sel.personId,
      kind: 'upsert',
      base_version: 0,
    });
    // A collector with one branch: the server defaults the scope, nothing is guessed here.
    expect(ops[0]!.fields).not.toHaveProperty('branch_id');
  });

  it('requires the Arabic name; a Latin name typed first lands in the Latin field', async () => {
    const { onChange } = renderPicker();
    type(input(), 'Salim Khamis');
    fireEvent.click(await screen.findByTestId('person-picker-new'));
    expect(
      ((await screen.findByTestId('person-picker-new-name-latin')) as HTMLInputElement).value,
    ).toBe('Salim Khamis');
    fireEvent.click(screen.getByTestId('person-picker-new-confirm'));
    expect(await screen.findByText('اكتب الاسم بالعربية')).toBeTruthy();
    expect(screen.getByTestId('person-picker-new-name-ar').getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects an invalid phone next to the field', async () => {
    const { onChange } = renderPicker();
    type(input(), 'سالم');
    fireEvent.click(await screen.findByTestId('person-picker-new'));
    await screen.findByTestId('person-picker-new-name-ar');
    await dialReady();
    type(screen.getByTestId('person-picker-new-phone'), '12');
    fireEvent.click(screen.getByTestId('person-picker-new-confirm'));
    expect(await screen.findByText('رقم الهاتف غير صحيح')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('while filling the new-person form, a phone that already exists offers "same person"', async () => {
    const { onChange } = renderPicker();
    type(input(), 'خالد');
    fireEvent.click(await screen.findByTestId('person-picker-new'));
    await screen.findByTestId('person-picker-new-name-ar');
    await dialReady();
    type(screen.getByTestId('person-picker-new-phone'), '0711000103');
    const same = await screen.findByTestId('person-picker-same');
    expect(same.dataset.personId).toBe(P_KHALID);
    fireEvent.click(same);
    expect(onChange).toHaveBeenCalledWith({ personId: P_KHALID });
  });

  it('shows the chosen person for an existing value and "change" returns to the search', async () => {
    renderPicker({ value: P_MOHAMED });
    const selected = await screen.findByTestId('person-picker-selected');
    await waitFor(() => expect(within(selected).getByText('محمد علي')).toBeTruthy());
    fireEvent.click(screen.getByTestId('person-picker-change'));
    expect(await screen.findByTestId('person-picker-input')).toBeTruthy();
    // Changing one's mind keeps the current person.
    fireEvent.click(screen.getByTestId('person-picker-keep'));
    expect(await screen.findByTestId('person-picker-selected')).toBeTruthy();
  });

  it('follows the value of the parent: a reset to null shows the search box again', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<PersonPicker value={P_MOHAMED} onChange={onChange} />);
    expect(await screen.findByTestId('person-picker-selected')).toBeTruthy();
    rerender(<PersonPicker value={null} onChange={onChange} />);
    expect(await screen.findByTestId('person-picker-input')).toBeTruthy();
    rerender(<PersonPicker value={P_KHALID} onChange={onChange} />);
    const selected = await screen.findByTestId('person-picker-selected');
    await waitFor(() => expect(within(selected).getByText('خالد حسن')).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports what is typed and restores it when mounted again (Back, reload — brief §7.4)', async () => {
    const onDraftChange = vi.fn((_d: PersonPickerDraft | null) => undefined);
    renderPicker({ role: 'imam', onDraftChange });
    type(input(), 'حمدان بن راشد');
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith({ mode: 'search', query: 'حمدان بن راشد' }),
    );
    fireEvent.click(await screen.findByTestId('person-picker-new'));
    await screen.findByTestId('person-picker-new-name-ar');
    await dialReady();
    type(screen.getByTestId('person-picker-new-name-latin'), 'Hamdan bin Rashid');
    type(screen.getByTestId('person-picker-new-phone'), '0777 123 456');
    type(screen.getByTestId('person-picker-new-birth-year'), '1979');
    await waitFor(() => expect(onDraftChange.mock.lastCall?.[0]?.form?.birth_year).toBe('1979'));
    const saved = onDraftChange.mock.lastCall![0]!;
    expect(saved).toMatchObject({
      mode: 'new',
      query: 'حمدان بن راشد',
      form: {
        name_ar: 'حمدان بن راشد',
        name_latin: 'Hamdan bin Rashid',
        dial: '255',
        phone: '0777 123 456',
        birth_year: '1979',
      },
    });

    // The page goes away (Back / reload) and the picker comes back with the stored draft.
    cleanup();
    const again = vi.fn((_d: PersonPickerDraft | null) => undefined);
    const { onChange } = renderPicker({
      role: 'imam',
      draft: JSON.parse(JSON.stringify(saved)) as PersonPickerDraft,
      onDraftChange: again,
    });
    expect(
      ((await screen.findByTestId('person-picker-new-name-ar')) as HTMLInputElement).value,
    ).toBe('حمدان بن راشد');
    expect((screen.getByTestId('person-picker-new-name-latin') as HTMLInputElement).value).toBe(
      'Hamdan bin Rashid',
    );
    expect((screen.getByTestId('person-picker-new-phone') as HTMLInputElement).value).toBe(
      '0777 123 456',
    );
    expect((screen.getByTestId('person-picker-new-birth-year') as HTMLInputElement).value).toBe(
      '1979',
    );
    await dialReady();
    await new Promise((r) => setTimeout(r, 50));
    expect(again).not.toHaveBeenCalled(); // restoring is not a change

    // The choice is handed over: nothing is left to keep.
    fireEvent.click(screen.getByTestId('person-picker-new-confirm'));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        newPerson: {
          name_ar: 'حمدان بن راشد',
          name_latin: 'Hamdan bin Rashid',
          phone_e164: '+255777123456',
          birth_year: 1979,
        },
      }),
    );
    await waitFor(() => expect(again).toHaveBeenLastCalledWith(null));
  });

  it('restores the search text, and ignores a damaged draft', async () => {
    renderPicker({ draft: { mode: 'search', query: 'محمد علي' } });
    expect(input().value).toBe('محمد علي');
    expect((await screen.findByTestId('person-picker-candidate')).dataset.personId).toBe(P_MOHAMED);
    cleanup();
    renderPicker({ draft: { mode: 'other', query: 5 } as unknown as PersonPickerDraft });
    expect(input().value).toBe('');
  });

  it('can hide "new person" and exclude persons already listed', async () => {
    renderPicker({ allowNew: false, excludeIds: [P_MOHAMED] });
    type(input(), 'محمد علي');
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByTestId('person-picker-candidate')).toBeNull();
    expect(screen.queryByTestId('person-picker-new')).toBeNull();
  });
});
