import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(async (_fn: string, _args?: Record<string, unknown>): Promise<unknown> => ({})),
}));

vi.mock('../auth', () => ({ supabase: {} }));
vi.mock('../sync', async () => {
  const errors = await import('../sync/errors');
  return { transport: { rpc: mocks.rpc }, isSyncError: errors.isSyncError };
});

import { SyncError } from '../sync/errors';
import {
  mergePersons,
  requestPersonMerge,
  resolvePersonMergeRequest,
  revertPersonMerge,
  rpcErrorKey,
  serverCandidates,
} from './rpc';

afterEach(() => mocks.rpc.mockReset());

describe('people RPC calls (people-admin.md §3–4)', () => {
  it('sends the documented arguments', async () => {
    mocks.rpc.mockResolvedValue([]);
    await serverCandidates({ name: 'محمد', phone: '+255711000102', adminAreaId: 'a1' });
    await mergePersons('s', 't', 'why');
    await revertPersonMerge('r');
    await requestPersonMerge('s', 't', 'why');
    await resolvePersonMergeRequest('r', 'reject', 'note');
    expect(mocks.rpc.mock.calls).toEqual([
      ['person_candidates', { p_name: 'محمد', p_phone: '+255711000102', p_admin_area_id: 'a1' }],
      ['merge_persons', { p_source: 's', p_target: 't', p_reason: 'why' }],
      ['revert_person_merge', { p_request_id: 'r' }],
      ['request_person_merge', { p_source: 's', p_target: 't', p_reason: 'why' }],
      ['resolve_person_merge_request', { p_request_id: 'r', p_decision: 'reject', p_note: 'note' }],
    ]);
  });

  it('parses the candidates answer defensively', async () => {
    mocks.rpc.mockResolvedValue([
      { id: 'x', name_ar: 'أ', reasons: ['phone'], phone_masked: true },
      7,
    ]);
    const out = await serverCandidates({ name: 'أب', phone: null, adminAreaId: null });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'x', phone_masked: true, reasons: ['phone'], staff: [] });
  });
});

describe('rpcErrorKey', () => {
  it.each([
    ['merge_persons: person_already_merged', 'conflict', 'people.err_person_already_merged'],
    ['revert_person_merge: merge_not_revertible', 'conflict', 'people.err_merge_not_revertible'],
    [
      'resolve_person_merge_request: request_not_pending',
      'conflict',
      'people.err_request_not_pending',
    ],
    ['merge_persons: forbidden', 'forbidden', 'people.err_forbidden'],
    ['merge_persons: person_not_found', 'not_found', 'people.err_person_not_found'],
    ['merge_persons: rate_limited', 'rate_limited', 'people.err_rate_limited'],
    ['merge_persons: Failed to fetch', 'network', 'people.err_network'],
    ['merge_persons: timed out', 'timeout', 'people.err_network'],
    ['merge_persons: HTTP 500', 'server', 'people.err_unknown'],
  ] as const)('%s → %s', (message, kind, key) => {
    expect(rpcErrorKey(new SyncError(kind, message))).toBe(key);
  });

  it('falls back for foreign errors', () => {
    expect(rpcErrorKey(new Error('x'))).toBe('people.err_unknown');
  });
});
