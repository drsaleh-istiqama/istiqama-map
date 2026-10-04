/**
 * Reading v2 data: the two localStorage keys of a device that ran v2, or a v2 backup file
 * ("نسخة احتياطية", `istiqama-backup-YYYY-MM-DD.json` = `JSON.stringify(projects, null, 2)`).
 * Pure apart from the injected `read` function; nothing here writes or deletes anything.
 */
import type { V2Data, V2Person, V2Project, V2SourceKind } from './v2types';
import { V2_PEOPLE_KEY, V2_PROJECTS_KEY } from './v2types';

export type V2ReadError =
  /** Not JSON at all (truncated file, wrong file). */
  | 'malformed_json'
  /** JSON, but not a list of v2 projects. */
  | 'not_v2'
  /** A valid file without a single project. */
  | 'empty';

export type V2ReadResult =
  { ok: true; data: V2Data } | { ok: false; error: V2ReadError; detail?: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** FNV-1a (32 bit, twice with different seeds → 16 hex digits). Stable across devices. */
export function fingerprintOf(...parts: ReadonlyArray<string | null | undefined>): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (const part of parts) {
    const text = part ?? '';
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 13);
    }
    // Part separator, so ("ab", "") and ("a", "b") differ.
    h1 = Math.imul(h1 ^ 0x1f, 0x01000193);
    h2 = Math.imul(h2 ^ 0x1f, 0x01000193);
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h1) + hex(h2);
}

/** A list element counts as a v2 project when it is an object with at least one v2 field. */
const PROJECT_HINTS = [
  'name',
  'type',
  'lat',
  'lng',
  'country',
  'region',
  'status',
  'staff',
  'photos',
  'photo',
];

function looksLikeProject(v: unknown): v is V2Project {
  return isRecord(v) && PROJECT_HINTS.some((k) => k in v);
}

function looksLikePerson(v: unknown): v is V2Person {
  return isRecord(v) && typeof v.name === 'string';
}

/**
 * Parses the text of a v2 backup file. Accepted: the array v2 writes, or an object
 * `{ projects: [...], people?: [...] }` (hand-made bundles of both keys).
 */
export function parseV2Json(text: string, fileName?: string): V2ReadResult {
  let value: unknown;
  try {
    // A UTF-8 byte-order mark (Windows editors) is not part of the JSON.
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return { ok: false, error: 'malformed_json', detail: e instanceof Error ? e.message : '' };
  }
  let projects: unknown;
  let people: unknown = [];
  if (Array.isArray(value)) projects = value;
  else if (isRecord(value) && Array.isArray(value.projects)) {
    projects = value.projects;
    if (Array.isArray(value.people)) people = value.people;
  } else return { ok: false, error: 'not_v2' };

  const list = projects as unknown[];
  const persons = (people as unknown[]).filter(looksLikePerson);
  if (list.length === 0 && persons.length === 0) return { ok: false, error: 'empty' };
  if (list.some((p) => !looksLikeProject(p))) return { ok: false, error: 'not_v2' };
  return {
    ok: true,
    data: {
      source: 'v2_json',
      projects: list as V2Project[],
      people: persons,
      fingerprint: fingerprintOf('v2_json', text),
      ...(fileName ? { fileName } : {}),
    },
  };
}

export interface V2LocalState {
  /** Raw values of the two keys (null = key absent). */
  raw: { projects: string | null; people: string | null };
  /** Parsed data, or null when there is nothing to migrate. */
  data: V2Data | null;
  /** Keys present but unreadable (v2 itself showed nothing for them). They are never deleted. */
  unreadable: Array<typeof V2_PROJECTS_KEY | typeof V2_PEOPLE_KEY>;
}

function parseList(raw: string | null): { list: unknown[]; bad: boolean } {
  if (raw === null) return { list: [], bad: false };
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? { list: v, bad: false } : { list: [], bad: true };
  } catch {
    return { list: [], bad: true };
  }
}

/**
 * Reads the v2 keys of this device. `read` is `readLegacyV2` of src/lib/prefs.ts (the only
 * code allowed to touch un-namespaced localStorage keys).
 */
export function readV2Local(read: (key: string) => string | null): V2LocalState {
  const raw = { projects: read(V2_PROJECTS_KEY), people: read(V2_PEOPLE_KEY) };
  const p = parseList(raw.projects);
  const q = parseList(raw.people);
  const unreadable: V2LocalState['unreadable'] = [];
  if (p.bad) unreadable.push(V2_PROJECTS_KEY);
  if (q.bad) unreadable.push(V2_PEOPLE_KEY);
  const projects = p.list.filter(looksLikeProject);
  const people = q.list.filter(looksLikePerson);
  const data: V2Data | null =
    projects.length > 0 || people.length > 0
      ? {
          source: 'v2_local' satisfies V2SourceKind,
          projects,
          people,
          fingerprint: fingerprintOf('v2_local', raw.projects, raw.people),
        }
      : null;
  return { raw, data, unreadable };
}

/** True when the device still holds v2 data worth offering (at least one readable record). */
export function hasV2LocalData(read: (key: string) => string | null): boolean {
  return readV2Local(read).data !== null;
}
