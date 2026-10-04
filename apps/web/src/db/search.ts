/**
 * Offline global search (brief §5): project names in Arabic and Latin, project code,
 * locality, staff names, donors — from the token indexes, bounded reads per keystroke.
 * The caller debounces (250 ms). Result shape = the server `search` RPC, so the UI renders
 * local and server hits with the same component.
 *
 * Privacy: a viewer's device holds no `persons` / `project_staff` rows (they are never
 * pulled), so staff hits cannot appear for viewers.
 */
import { norm } from '../lib/normalize';
import { similarity } from '../lib/similarity';
import type { StoredDonor, StoredLocality, StoredPerson, StoredProject } from './derive';
import { db } from './dexie';
import { matchQuality, matchesAllWords, queryWords } from './tokens';
import type { Row } from './types';

export interface SearchProjectRef {
  id: string;
  code: string | null;
  name_ar: string;
  name_latin: string | null;
  type: Row<'projects'>['type'];
  status: Row<'projects'>['status'];
  lon: number | null;
  lat: number | null;
  /** Staff hits only. */
  role?: Row<'project_staff'>['role'];
}

export type SearchHit =
  | {
      kind: 'project';
      id: string;
      score: number;
      name_ar: string;
      name_latin: string | null;
      code: string | null;
      type: Row<'projects'>['type'];
      status: Row<'projects'>['status'];
      record_state: Row<'projects'>['record_state'];
      lon: number | null;
      lat: number | null;
      country_id: string | null;
      admin_area_id: string | null;
      locality_id: string | null;
    }
  | {
      kind: 'locality';
      id: string;
      score: number;
      name_ar: string | null;
      name_latin: string | null;
      status: Row<'localities'>['status'];
      lon: number | null;
      lat: number | null;
      country_id: string;
      admin_area_id: string | null;
    }
  | {
      kind: 'staff';
      /** Person id. */
      id: string;
      score: number;
      name_ar: string | null;
      name_latin: string | null;
      projects_count: number;
      /** At most 5, current assignments first. */
      projects: SearchProjectRef[];
    }
  | {
      kind: 'donor';
      id: string;
      score: number;
      name_ar: string | null;
      name_latin: string | null;
      projects_count: number;
      /** At most 5. */
      projects: SearchProjectRef[];
    };

export type SearchKind = SearchHit['kind'];

const KIND_ORDER: Record<SearchKind, number> = { project: 0, locality: 1, staff: 2, donor: 3 };

type Tokenised = { id: string; _tokens?: string[] };

/** Index keys read per query word at most (complete id lists are built only for rarer words). */
export const SEARCH_KEY_BUDGET = 1000;

/**
 * Rows of a store whose tokens match every word. Bounded per call whatever the size of the
 * store: at most `SEARCH_KEY_BUDGET` index keys per word and at most `cap` rows are read.
 *   - native index counts tell how selective each word is (nothing is loaded for that);
 *   - the id lists of the selective words are intersected on keys;
 *   - when every word is very common the answer is a sample of the rarest one, not the full
 *     set (the user narrows the query) — like the server's candidate cap.
 */
async function candidates<R extends Tokenised>(
  store: 'projects' | 'localities' | 'persons' | 'donors',
  qWords: string[],
  cap: number,
): Promise<R[]> {
  const table = db.table(store);
  const counts = await Promise.all(qWords.map((w) => table.where('_tokens').startsWith(w).count()));
  if (counts.some((n) => n === 0)) return [];
  const order = qWords.map((w, i) => ({ w, n: counts[i] ?? 0 })).sort((a, b) => a.n - b.n);
  const rarest = order[0];
  if (!rarest) return [];

  let ids: string[];
  if (rarest.n <= SEARCH_KEY_BUDGET) {
    let set: Set<string> | null = null;
    for (const { w, n } of order) {
      if (n > SEARCH_KEY_BUDGET) break;
      const list = new Set((await table.where('_tokens').startsWith(w).primaryKeys()) as string[]);
      if (set === null) {
        set = list;
      } else {
        const narrowed = new Set<string>();
        for (const id of set) if (list.has(id)) narrowed.add(id);
        set = narrowed;
      }
      if (set.size <= cap) break; // few enough: the remaining words are checked on the rows
    }
    ids = [...(set ?? [])];
  } else {
    const sample = (await table
      .where('_tokens')
      .startsWith(rarest.w)
      .limit(cap)
      .primaryKeys()) as string[];
    ids = [...new Set(sample)];
  }
  if (ids.length === 0) return [];
  const rows = (await table.bulkGet(ids.slice(0, cap))) as Array<R | undefined>;
  return rows.filter((r): r is R => !!r && matchesAllWords(r._tokens, qWords));
}

function scoreOf(
  qNorm: string,
  qWords: string[],
  tokens: string[] | undefined,
  ...names: Array<string | null>
): number {
  let bestSim = 0;
  for (const n of names) {
    if (!n) continue;
    const nn = norm(n);
    if (nn === qNorm) return 1;
    const s = similarity(qNorm, nn);
    if (s > bestSim) bestSim = s;
  }
  const quality = matchQuality(tokens, qWords);
  return Math.min(0.99, Math.round((0.75 * quality + 0.24 * bestSim) * 1000) / 1000);
}

const projectRef = (p: Row<'projects'>): SearchProjectRef => ({
  id: p.id,
  code: p.code,
  name_ar: p.name_ar,
  name_latin: p.name_latin,
  type: p.type,
  status: p.status,
  lon: p.lon,
  lat: p.lat,
});

/**
 * Searches the device. Queries shorter than two characters (after normalisation) return
 * `[]`. Every word of the query must start a word of the hit. Best hits first; on equal
 * score: projects, localities, staff, donors. At most `limit` (default 20, max 50) hits.
 */
export async function searchLocal(
  q: string,
  limit = 20,
  kinds?: readonly SearchKind[],
): Promise<SearchHit[]> {
  const size = Math.max(1, Math.min(50, Math.floor(limit) || 20));
  const qNorm = norm(q ?? '');
  const qWords = queryWords(qNorm);
  if (qNorm.length < 2 || qWords.length === 0) return [];
  const want = (k: SearchKind): boolean => !kinds || kinds.includes(k);
  const cap = size * 4;

  return db.transaction(
    'r',
    [db.projects, db.localities, db.persons, db.donors, db.project_staff, db.project_donors],
    async () => {
      const hits: SearchHit[] = [];

      if (want('project')) {
        for (const p of await candidates<StoredProject>('projects', qWords, cap)) {
          const exactCode = p.code !== null && norm(p.code) === qNorm;
          hits.push({
            kind: 'project',
            id: p.id,
            score: exactCode ? 1 : scoreOf(qNorm, qWords, p._tokens, p.name_ar, p.name_latin),
            name_ar: p.name_ar,
            name_latin: p.name_latin,
            code: p.code,
            type: p.type,
            status: p.status,
            record_state: p.record_state,
            lon: p.lon,
            lat: p.lat,
            country_id: p.country_id,
            admin_area_id: p.admin_area_id,
            locality_id: p.locality_id,
          });
        }
      }

      if (want('locality')) {
        for (const l of await candidates<StoredLocality>('localities', qWords, cap)) {
          hits.push({
            kind: 'locality',
            id: l.id,
            score: scoreOf(qNorm, qWords, l._tokens, l.name_ar, l.name_latin),
            name_ar: l.name_ar,
            name_latin: l.name_latin,
            status: l.status,
            lon: l.lon,
            lat: l.lat,
            country_id: l.country_id,
            admin_area_id: l.admin_area_id,
          });
        }
      }

      if (want('staff')) {
        // Rank first, then look up assignments for the best persons only.
        const persons = (await candidates<StoredPerson>('persons', qWords, cap))
          .filter((p) => !p.merged_into_id)
          .map((p) => ({ p, score: scoreOf(qNorm, qWords, p._tokens, p.name_ar, p.name_latin) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, size);
        for (const { p, score } of persons) {
          const links = await db.project_staff.where('person_id').equals(p.id).toArray();
          if (links.length === 0) continue; // a person without a project here is not a "staff" hit
          links.sort((a, b) => Number(a.end_date !== null) - Number(b.end_date !== null));
          const shown = links.slice(0, 5);
          const projects = await db.projects.bulkGet(shown.map((l) => l.project_id));
          const refs: SearchProjectRef[] = [];
          shown.forEach((l, i) => {
            const pr = projects[i];
            if (pr) refs.push({ ...projectRef(pr), role: l.role });
          });
          if (refs.length === 0) continue;
          hits.push({
            kind: 'staff',
            id: p.id,
            score,
            name_ar: p.name_ar,
            name_latin: p.name_latin,
            projects_count: links.length,
            projects: refs,
          });
        }
      }

      if (want('donor')) {
        const donors = (await candidates<StoredDonor>('donors', qWords, cap))
          .map((d) => ({ d, score: scoreOf(qNorm, qWords, d._tokens, d.name_ar, d.name_latin) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, size);
        for (const { d, score } of donors) {
          const total = await db.project_donors.where('donor_id').equals(d.id).count();
          const links = await db.project_donors.where('donor_id').equals(d.id).limit(5).toArray();
          const projects = await db.projects.bulkGet(links.map((l) => l.project_id));
          hits.push({
            kind: 'donor',
            id: d.id,
            score,
            name_ar: d.name_ar,
            name_latin: d.name_latin,
            projects_count: total,
            projects: projects.filter((x): x is Row<'projects'> => !!x).map(projectRef),
          });
        }
      }

      hits.sort(
        (a, b) =>
          b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : 1),
      );
      return hits.slice(0, size);
    },
  );
}
