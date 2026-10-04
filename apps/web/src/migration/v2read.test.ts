import { describe, expect, it } from 'vitest';
import { SAMPLE_PROJECTS } from './testing/fixtures';
import { fingerprintOf, hasV2LocalData, parseV2Json, readV2Local } from './v2read';
import { V2_PEOPLE_KEY, V2_PROJECTS_KEY } from './v2types';

const BOM = String.fromCharCode(0xfeff);

describe('parseV2Json — v2 backup files', () => {
  it('reads the array v2 writes (JSON.stringify(projects, null, 2))', () => {
    const text = JSON.stringify(SAMPLE_PROJECTS, null, 2);
    const r = parseV2Json(text, 'istiqama-backup-2026-01-01.json');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source).toBe('v2_json');
    expect(r.data.projects).toHaveLength(5);
    expect(r.data.people).toEqual([]);
    expect(r.data.fileName).toBe('istiqama-backup-2026-01-01.json');
    expect(r.data.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('accepts a byte-order mark and a hand-made { projects, people } bundle', () => {
    const r1 = parseV2Json(BOM + JSON.stringify(SAMPLE_PROJECTS));
    expect(r1.ok).toBe(true);
    const r2 = parseV2Json(
      JSON.stringify({
        projects: SAMPLE_PROJECTS.slice(0, 1),
        people: [{ name: 'زينب' }, { bogus: 1 }],
      }),
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.data.projects).toHaveLength(1);
      expect(r2.data.people).toEqual([{ name: 'زينب' }]);
    }
  });

  it('malformed JSON (truncated file) is reported, never thrown', () => {
    const text = JSON.stringify(SAMPLE_PROJECTS).slice(0, 120);
    const r = parseV2Json(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('malformed_json');
    expect(parseV2Json('').ok).toBe(false);
  });

  it('JSON that is not a v2 export is refused', () => {
    for (const text of ['42', '"text"', '{"a":1}', '[1,2,3]', '[{"foo":"bar"}]', 'null']) {
      const r = parseV2Json(text);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.error, text).toBe('not_v2');
    }
  });

  it('an empty list is "empty"', () => {
    const r = parseV2Json('[]');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('empty');
  });

  it('the fingerprint identifies the content (same text → same run)', () => {
    const a = parseV2Json(JSON.stringify(SAMPLE_PROJECTS));
    const b = parseV2Json(JSON.stringify(SAMPLE_PROJECTS));
    const c = parseV2Json(JSON.stringify(SAMPLE_PROJECTS.slice(1)));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(a.data.fingerprint).toBe(b.data.fingerprint);
      expect(a.data.fingerprint).not.toBe(c.data.fingerprint);
    }
    expect(fingerprintOf('ab', '')).not.toBe(fingerprintOf('a', 'b'));
  });
});

describe('readV2Local — the two localStorage keys of a v2 device', () => {
  const store = (entries: Record<string, string>) => (k: string) => entries[k] ?? null;

  it('reads projects and the person directory', () => {
    const read = store({
      [V2_PROJECTS_KEY]: JSON.stringify(SAMPLE_PROJECTS),
      [V2_PEOPLE_KEY]: JSON.stringify([{ name: 'عبدالله سالم', roles: ['manager'] }]),
    });
    const s = readV2Local(read);
    expect(s.data?.source).toBe('v2_local');
    expect(s.data?.projects).toHaveLength(5);
    expect(s.data?.people).toHaveLength(1);
    expect(s.unreadable).toEqual([]);
    expect(hasV2LocalData(read)).toBe(true);
  });

  it('people only (projects key absent) is still data to migrate', () => {
    const s = readV2Local(store({ [V2_PEOPLE_KEY]: JSON.stringify([{ name: 'زينب' }]) }));
    expect(s.data?.projects).toEqual([]);
    expect(s.data?.people).toHaveLength(1);
  });

  it('unreadable keys are reported and nothing is offered for them', () => {
    const s = readV2Local(store({ [V2_PROJECTS_KEY]: '{broken', [V2_PEOPLE_KEY]: '{"x":1}' }));
    expect(s.data).toBeNull();
    expect(s.unreadable).toEqual([V2_PROJECTS_KEY, V2_PEOPLE_KEY]);
  });

  it('no keys → nothing to migrate', () => {
    expect(readV2Local(store({})).data).toBeNull();
    expect(hasV2LocalData(store({}))).toBe(false);
    expect(hasV2LocalData(store({ [V2_PROJECTS_KEY]: '[]' }))).toBe(false);
  });

  it('the fingerprint changes when the stored data changes', () => {
    const a = readV2Local(store({ [V2_PROJECTS_KEY]: JSON.stringify(SAMPLE_PROJECTS) }));
    const b = readV2Local(store({ [V2_PROJECTS_KEY]: JSON.stringify(SAMPLE_PROJECTS.slice(2)) }));
    expect(a.data?.fingerprint).not.toBe(b.data?.fingerprint);
  });
});
