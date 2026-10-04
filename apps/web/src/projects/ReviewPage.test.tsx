import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

import { ackOp, applyServerRows, db, mutate, newRow, type Row } from '../db';
import { freshDb, serverProject, serverRow, USER_B } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { clearViewFilters } from '../routes';
import { formatConflictValue } from './ConflictsPanel';
import { errorLabel } from './FailedOpsPanel';
import ReviewPage from './ReviewPage';
import { resetSyncMocks, setOnline, syncMocks, useRole } from './testkit';

const P1 = '00000000-0080-7000-8000-0000000000b1';
const P2 = '00000000-0080-7000-8000-0000000000b2';
const P3 = '00000000-0080-7000-8000-0000000000b3';
const COUNTRY = '10000000-0000-4000-8000-000000000001';

function conflict(values: Partial<Row<'sync_conflicts'>> = {}): Row<'sync_conflicts'> {
  return serverRow('sync_conflicts', {
    table_name: 'projects',
    row_id: P1,
    project_id: P1,
    field: 'builder',
    base_version: 1,
    server_value: 'Istiqama',
    client_value: 'Village committee',
    client_user_id: USER_B,
    client_device_id: 'device-abcdef123',
    state: 'open',
    ...values,
  });
}

async function seedProjects(): Promise<void> {
  await applyServerRows('projects', [
    serverProject({
      id: P1,
      name_ar: 'مسجد ١',
      name_latin: 'Masjid One',
      record_state: 'submitted',
      country_id: COUNTRY,
    }),
    serverProject({
      id: P2,
      name_ar: 'مسجد ٢',
      name_latin: 'Masjid Two',
      record_state: 'submitted',
      country_id: COUNTRY,
    }),
    serverProject({
      id: P3,
      name_ar: 'مسجد ٣',
      name_latin: 'Masjid Three',
      record_state: 'approved',
      country_id: COUNTRY,
    }),
  ]);
}

beforeEach(async () => {
  await freshDb({ canSeeRestricted: false });
  await setLocale('en');
  clearViewFilters();
  resetSyncMocks();
  useRole('branch_supervisor');
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('access', () => {
  it('is for reviewers only', async () => {
    useRole('field_collector');
    render(<ReviewPage />);
    expect(screen.getByTestId('review-forbidden')).toBeTruthy();
    expect(screen.queryByTestId('review-submitted')).toBeNull();
  });
});

describe('(a) submitted records', () => {
  it('flags a record that carries a v2 migration note (migration 0073)', async () => {
    await seedProjects();
    await applyServerRows('projects', [
      serverProject({
        id: P2,
        name_ar: 'مسجد ٢',
        name_latin: 'Masjid Two',
        record_state: 'submitted',
        country_id: COUNTRY,
        version: 2,
        migration_note: 'Salaries were given the currency TZS; check it',
      }),
    ]);
    render(<ReviewPage />);
    await waitFor(() => expect(screen.getAllByTestId('review-row')).toHaveLength(2));
    const rowOf = (id: string): HTMLElement =>
      screen.getAllByTestId('review-row').find((r) => r.getAttribute('data-id') === id)!;
    const flag = await within(rowOf(P2)).findByTestId('review-migration-note');
    expect(flag.textContent).toBe('Migration note');
    expect(flag.getAttribute('title')).toContain('TZS');
    expect(within(rowOf(P1)).queryByTestId('review-migration-note')).toBeNull();
  });

  it('lists the submitted records; approve and return from the queue', async () => {
    await seedProjects();
    render(<ReviewPage />);
    await waitFor(() => expect(screen.getAllByTestId('review-row')).toHaveLength(2));
    await waitFor(() =>
      expect(within(screen.getByTestId('review-tab-submitted')).getByText('2')).toBeTruthy(),
    );

    const row1 = screen.getAllByTestId('review-row').find((r) => r.getAttribute('data-id') === P1)!;
    fireEvent.click(within(row1).getByTestId('review-approve'));
    await waitFor(async () => expect((await db.projects.get(P1))?.record_state).toBe('approved'));
    await waitFor(() => expect(screen.getAllByTestId('review-row')).toHaveLength(1));
    expect(syncMocks.syncNow).toHaveBeenCalled();

    fireEvent.click(within(screen.getByTestId('review-row')).getByTestId('review-return'));
    fireEvent.input(await screen.findByTestId('return-note'), { target: { value: 'Add photos' } });
    fireEvent.click(screen.getByTestId('return-confirm'));
    await waitFor(async () => expect((await db.projects.get(P2))?.record_state).toBe('returned'));
    expect((await db.projects.get(P2))?.review_note).toBe('Add photos');
    await waitFor(() => expect(screen.getByTestId('review-submitted-empty')).toBeTruthy());
    const states = (await db.outbox.toArray()).map((o) => [o.row_id, o.fields.record_state]);
    expect(states).toEqual(
      expect.arrayContaining([
        [P1, 'approved'],
        [P2, 'returned'],
      ]),
    );
  });
});

describe('(b) sync conflicts', () => {
  it('shows field, both values, who and when; "keep server" calls resolve_conflict then syncs', async () => {
    await seedProjects();
    const c = conflict();
    await applyServerRows('sync_conflicts', [c]);
    syncMocks.rpc.mockResolvedValue({ id: c.id, state: 'resolved_server' });
    render(<ReviewPage />);
    fireEvent.click(screen.getByTestId('review-tab-conflicts'));
    const row = await screen.findByTestId('conflict-row');
    expect(row.getAttribute('data-field')).toBe('builder');
    expect(within(row).getByTestId('conflict-server-value').textContent).toContain('Istiqama');
    expect(within(row).getByTestId('conflict-client-value').textContent).toContain(
      'Village committee',
    );
    expect(row.textContent).toContain('Builder');
    expect(row.textContent).toContain('Masjid One');
    expect(row.textContent).toContain('Another user');

    fireEvent.click(within(row).getByTestId('conflict-keep-server'));
    await waitFor(() => expect(screen.queryByTestId('conflict-row')).toBeNull());
    expect(syncMocks.rpc).toHaveBeenCalledWith('resolve_conflict', {
      p_conflict_id: c.id,
      p_choice: 'server',
    });
    expect(syncMocks.syncNow).toHaveBeenCalledTimes(1);
    expect(syncMocks.rpc.mock.invocationCallOrder[0]!).toBeLessThan(
      syncMocks.syncNow.mock.invocationCallOrder[0]!,
    );
  });

  it('"keep client" sends the client choice', async () => {
    const c = conflict({
      field: 'geom',
      server_value: { lon: 39.7, lat: -5.1 },
      client_value: { lon: 39.8, lat: -5.2 },
    });
    await applyServerRows('sync_conflicts', [c]);
    syncMocks.rpc.mockResolvedValue({ id: c.id, state: 'resolved_client' });
    render(<ReviewPage />);
    fireEvent.click(screen.getByTestId('review-tab-conflicts'));
    const row = await screen.findByTestId('conflict-row');
    expect(within(row).getByTestId('conflict-client-value').textContent).toContain(
      '-5.200000, 39.800000',
    );
    fireEvent.click(within(row).getByTestId('conflict-keep-client'));
    await waitFor(() =>
      expect(syncMocks.rpc).toHaveBeenCalledWith('resolve_conflict', {
        p_conflict_id: c.id,
        p_choice: 'client',
      }),
    );
    await waitFor(() => expect(syncMocks.syncNow).toHaveBeenCalled());
  });

  it('conflicts about restricted tables only for restricted roles', async () => {
    await applyServerRows('sync_conflicts', [
      conflict(),
      conflict({
        table_name: 'staff_compensation',
        field: 'monthly_amount',
        row_id: P2,
        server_value: 100,
        client_value: 120,
      }),
    ]);
    const first = render(<ReviewPage />);
    fireEvent.click(screen.getByTestId('review-tab-conflicts'));
    await waitFor(() => expect(screen.getAllByTestId('conflict-row')).toHaveLength(1));
    expect(screen.getByTestId('conflict-row').getAttribute('data-field')).toBe('builder');
    first.unmount();

    useRole('country_manager');
    render(<ReviewPage />);
    await waitFor(() => expect(screen.getAllByTestId('conflict-row')).toHaveLength(2));
  });

  it('offline: the decision buttons are disabled and nothing is called', async () => {
    await applyServerRows('sync_conflicts', [conflict()]);
    setOnline(false);
    render(<ReviewPage />);
    fireEvent.click(screen.getByTestId('review-tab-conflicts'));
    const row = await screen.findByTestId('conflict-row');
    expect((within(row).getByTestId('conflict-keep-server') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((within(row).getByTestId('conflict-keep-client') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(syncMocks.rpc).not.toHaveBeenCalled();
  });

  it('an already resolved conflict leaves the list with a notice', async () => {
    await applyServerRows('sync_conflicts', [conflict()]);
    syncMocks.rpc.mockRejectedValue(
      Object.assign(new Error('conflict_already_resolved'), { name: 'SyncError' }),
    );
    render(<ReviewPage />);
    fireEvent.click(screen.getByTestId('review-tab-conflicts'));
    fireEvent.click(
      within(await screen.findByTestId('conflict-row')).getByTestId('conflict-keep-server'),
    );
    await waitFor(() => expect(screen.queryByTestId('conflict-row')).toBeNull());
    expect(await screen.findByText('This conflict was already resolved')).toBeTruthy();
  });

  it('formats values in words', () => {
    expect(formatConflictValue('status', 'maintenance')).toBe('Needs maintenance');
    expect(formatConflictValue('expandable', true)).toBe('Yes');
    expect(formatConflictValue('builder', null)).toBe('(empty)');
  });
});

describe('(c) proposed villages', () => {
  async function seedLocalities() {
    const proposed = serverRow('localities', {
      country_id: COUNTRY,
      name_ar: 'قرية جديدة',
      name_latin: 'Kijiji Kipya',
      status: 'proposed',
    });
    const approved = serverRow('localities', {
      country_id: COUNTRY,
      name_ar: 'القرية الكبرى',
      name_latin: 'Kijiji Kikuu',
      status: 'approved',
    });
    await applyServerRows('localities', [proposed, approved]);
    await applyServerRows('projects', [
      serverProject({ id: P1, name_ar: 'مسجد ١', country_id: COUNTRY, locality_id: proposed.id }),
    ]);
    return { proposed, approved };
  }

  it('approves a proposed village (localities.status = approved, queued)', async () => {
    const { proposed } = await seedLocalities();
    render(<ReviewPage />);
    fireEvent.click(screen.getByTestId('review-tab-localities'));
    const row = await screen.findByTestId('locality-row');
    expect(row.textContent).toContain('Projects: 1');
    fireEvent.click(within(row).getByTestId('locality-approve'));
    await waitFor(async () =>
      expect((await db.localities.get(proposed.id))?.status).toBe('approved'),
    );
    const op = (await db.outbox.toArray()).find((o) => o.table === 'localities');
    expect(op?.fields).toEqual({ status: 'approved' });
    await waitFor(() => expect(screen.getByTestId('localities-empty')).toBeTruthy());
  });

  it('merges a proposed village into an existing one', async () => {
    const { proposed, approved } = await seedLocalities();
    render(<ReviewPage />);
    fireEvent.click(screen.getByTestId('review-tab-localities'));
    fireEvent.click(
      within(await screen.findByTestId('locality-row')).getByTestId('locality-merge'),
    );
    fireEvent.input(await screen.findByTestId('merge-search'), { target: { value: 'kikuu' } });
    fireEvent.click(await screen.findByTestId('merge-target'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(async () => expect((await db.projects.get(P1))?.locality_id).toBe(approved.id));
    await waitFor(async () => expect(await db.localities.get(proposed.id)).toBeUndefined());
    expect(
      (await db.outbox.toArray()).some((o) => o.table === 'localities' && o.kind === 'delete'),
    ).toBe(true);
  });

  it('corrects the name of a proposed village', async () => {
    const { proposed } = await seedLocalities();
    render(<ReviewPage />);
    fireEvent.click(screen.getByTestId('review-tab-localities'));
    fireEvent.click(within(await screen.findByTestId('locality-row')).getByTestId('locality-edit'));
    fireEvent.input(screen.getByTestId('locality-name-latin'), {
      target: { value: 'Kijiji Kipya Juu' },
    });
    fireEvent.click(screen.getByTestId('locality-save'));
    await waitFor(async () =>
      expect((await db.localities.get(proposed.id))?.name_latin).toBe('Kijiji Kipya Juu'),
    );
  });
});

describe('(d) rejected operations of this device', () => {
  async function rejectedInsert(code: string): Promise<string> {
    const row = newRow('projects', {
      name_ar: 'مسجد مرفوض',
      name_latin: 'Rejected Masjid',
      type: 'mosque',
    });
    await mutate('projects', row.id, row, { insert: true });
    const op = (await db.outbox.toArray())[0]!;
    await ackOp({ op_id: op.op_id, status: 'rejected', error: { code } });
    return row.id;
  }

  it('lists them with the reason; retry puts the op back into the outbox', async () => {
    const id = await rejectedInsert('out_of_scope');
    render(<ReviewPage />);
    fireEvent.click(screen.getByTestId('review-tab-failed'));
    const row = await screen.findByTestId('failed-op');
    expect(row.getAttribute('data-code')).toBe('out_of_scope');
    expect(within(row).getByTestId('failed-op-reason').textContent).toBe(
      errorLabel('out_of_scope'),
    );
    expect(row.textContent).toContain('Rejected Masjid');
    fireEvent.click(within(row).getByTestId('failed-retry'));
    await waitFor(async () => expect(await db.failed_ops.count()).toBe(0));
    expect((await db.outbox.toArray()).map((o) => o.row_id)).toEqual([id]);
    await waitFor(() => expect(screen.getByTestId('failed-ops-empty')).toBeTruthy());
  });

  it('discard asks first and removes a never-acknowledged insert', async () => {
    const id = await rejectedInsert('check_violation');
    render(<ReviewPage />);
    fireEvent.click(screen.getByTestId('review-tab-failed'));
    fireEvent.click(within(await screen.findByTestId('failed-op')).getByTestId('failed-discard'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(async () => expect(await db.failed_ops.count()).toBe(0));
    expect(await db.projects.get(id)).toBeUndefined();
    expect(await db.outbox.count()).toBe(0);
  });

  it('unknown codes are shown with the code', () => {
    expect(errorLabel('weird_code')).toBe('The server rejected this change (code: weird_code).');
  });
});
