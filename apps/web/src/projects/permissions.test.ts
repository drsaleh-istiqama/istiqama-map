import { describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());

import { RECORD_STATES, type RecordState } from '../db';
import {
  canAddMaintenance,
  canApprove,
  canChangeMaintenance,
  canDeleteProject,
  canEditProject,
  canReturn,
  canSubmit,
  type Actor,
} from './permissions';

const ME = 'user-me';
const OTHER = 'user-other';

const actors: Record<string, Actor> = {
  viewer: { userId: ME, write: false, review: false, seePeople: false, seeRestricted: false },
  collector: { userId: ME, write: true, review: false, seePeople: true, seeRestricted: false },
  supervisor: { userId: ME, write: true, review: true, seePeople: true, seeRestricted: false },
  manager: { userId: ME, write: true, review: true, seePeople: true, seeRestricted: true },
};

const project = (record_state: RecordState, created_by: string | null = ME) => ({
  record_state,
  created_by,
  lon: 39.2,
  lat: -6.1,
});

describe('delete permission matrix (sync.md §4.3)', () => {
  const expected: Record<string, Record<RecordState, [boolean, boolean]>> = {
    // [own record, somebody else's record]
    viewer: {
      draft: [false, false],
      submitted: [false, false],
      approved: [false, false],
      returned: [false, false],
    },
    collector: {
      draft: [true, false],
      submitted: [false, false],
      approved: [false, false],
      returned: [true, false],
    },
    supervisor: {
      draft: [true, true],
      submitted: [true, true],
      approved: [true, true],
      returned: [true, true],
    },
    manager: {
      draft: [true, true],
      submitted: [true, true],
      approved: [true, true],
      returned: [true, true],
    },
  };
  for (const [name, actor] of Object.entries(actors)) {
    for (const state of RECORD_STATES) {
      it(`${name} · ${state}`, () => {
        const [own, foreign] = expected[name]![state];
        expect(canDeleteProject(project(state, ME), actor)).toBe(own);
        expect(canDeleteProject(project(state, OTHER), actor)).toBe(foreign);
      });
    }
  }

  it('a collector without a user id never deletes', () => {
    expect(canDeleteProject(project('draft', null), { ...actors.collector!, userId: null })).toBe(
      false,
    );
  });
});

describe('edit, submit, review', () => {
  it('only the creator or a reviewer edits (project update class `creator`)', () => {
    expect(canEditProject(project('approved', ME), actors.collector!)).toBe(true);
    expect(canEditProject(project('draft', OTHER), actors.collector!)).toBe(false);
    expect(canEditProject(project('draft', OTHER), actors.supervisor!)).toBe(true);
    expect(canEditProject(project('draft', ME), actors.viewer!)).toBe(false);
  });

  it('approve from draft / submitted / returned, return from submitted / approved — reviewers only', () => {
    const states = (fn: typeof canApprove, actor: Actor) =>
      RECORD_STATES.filter((s) => fn(project(s), actor));
    expect(states(canApprove, actors.supervisor!)).toEqual(['draft', 'submitted', 'returned']);
    expect(states(canReturn, actors.supervisor!)).toEqual(['submitted', 'approved']);
    expect(states(canApprove, actors.collector!)).toEqual([]);
    expect(states(canReturn, actors.collector!)).toEqual([]);
  });

  it('submit needs a location and a draft / returned own record', () => {
    expect(canSubmit(project('draft'), actors.collector!)).toBe(true);
    expect(canSubmit(project('returned'), actors.collector!)).toBe(true);
    expect(canSubmit(project('submitted'), actors.collector!)).toBe(false);
    expect(canSubmit({ ...project('draft'), lon: null, lat: null }, actors.collector!)).toBe(false);
    expect(canSubmit(project('draft', OTHER), actors.collector!)).toBe(false);
  });

  it('maintenance: any writer adds; the entry creator or a reviewer changes', () => {
    expect(canAddMaintenance(actors.collector!)).toBe(true);
    expect(canAddMaintenance(actors.viewer!)).toBe(false);
    expect(canChangeMaintenance({ created_by: ME }, actors.collector!)).toBe(true);
    expect(canChangeMaintenance({ created_by: OTHER }, actors.collector!)).toBe(false);
    expect(canChangeMaintenance({ created_by: OTHER }, actors.supervisor!)).toBe(true);
  });
});
