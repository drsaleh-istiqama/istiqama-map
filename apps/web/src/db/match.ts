/**
 * Offline twins of the server's matching RPCs:
 *   - `findLocalDuplicates`       ~ `project_duplicates`  (brief §7.3)
 *   - `findLocalPersonCandidates` ~ `person_candidates`   (brief §2.4)
 * Both only LIST possible matches. Nothing here merges, links or changes any row: the user
 * decides ("same project / different project", "same person / new person").
 */
import { bboxAround, gridRangesForBBox, haversineMeters, isValidLonLat } from '../lib/geo';
import { norm } from '../lib/normalize';
import { similarity } from '../lib/similarity';
import { areaChain, type StoredPerson, type StoredProject } from './derive';
import { db } from './dexie';
import { getLocalSession, getNumberSetting } from './meta';
import { stripArabicArticle, words } from './tokens';
import type { Row } from './types';

// ---------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------

export interface DuplicateHit {
  id: string;
  code: string | null;
  name_ar: string;
  name_latin: string | null;
  type: Row<'projects'>['type'];
  status: Row<'projects'>['status'];
  record_state: Row<'projects'>['record_state'];
  lon: number | null;
  lat: number | null;
  locality_id: string | null;
  admin_area_id: string | null;
  created_by_me: boolean;
  /** Metres, one decimal; null without coordinates. */
  distance_m: number | null;
  /** 0..1 on the normalised names; null when no name was given. */
  similarity: number | null;
  reason: 'nearby' | 'similar_name' | 'both';
}

/**
 * Without a locality the server compares names inside the level-3 area that contains the
 * point. Ward shapes are not on the device, so offline the "same village" is approximated by
 * this radius around the point.
 */
export const SAME_VILLAGE_RADIUS_M = 1500;
const MAX_DUPLICATES = 20;

async function projectsNear(lon: number, lat: number, radiusM: number): Promise<StoredProject[]> {
  const ranges = gridRangesForBBox(bboxAround({ lon, lat }, radiusM));
  if (!ranges) return [];
  return (await db.projects
    .where('_cell')
    .inAnyRange(ranges, { includeLowers: true, includeUppers: true })
    .toArray()) as StoredProject[];
}

/**
 * Possible duplicates of a project being entered, best first (max 20):
 *   - `nearby`: same type (`combined` overlaps with mosque and school) within the duplicate
 *     radius (setting `duplicates.radius_m`, default 150 m);
 *   - `similar_name`: trigram similarity >= setting `duplicates.name_similarity` (default
 *     0.6) between the normalised name and the Arabic or Latin name of a project in the same
 *     locality — or, when no locality is chosen, within `SAME_VILLAGE_RADIUS_M`.
 */
export async function findLocalDuplicates(input: {
  type: string;
  lon: number;
  lat: number;
  name: string;
  localityId?: string | null;
  excludeId?: string;
}): Promise<DuplicateHit[]> {
  const radius = await getNumberSetting('duplicates.radius_m', 150, 1, 5000);
  const minSim = await getNumberSetting('duplicates.name_similarity', 0.6, 0.3, 1);
  const { userId } = await getLocalSession();
  const hasPoint = isValidLonLat(input);
  const name = norm(input.name ?? '');
  const hasName = name !== '';

  const pool = new Map<string, StoredProject>();
  if (hasPoint) {
    const reach = hasName && !input.localityId ? Math.max(radius, SAME_VILLAGE_RADIUS_M) : radius;
    for (const p of await projectsNear(input.lon, input.lat, reach)) pool.set(p.id, p);
  }
  if (hasName && input.localityId) {
    const same = (await db.projects.where('locality_id').equals(input.localityId).toArray()) as StoredProject[];
    for (const p of same) pool.set(p.id, p);
  }

  const hits: DuplicateHit[] = [];
  for (const p of pool.values()) {
    if (p.id === input.excludeId) continue;
    const distance = hasPoint && isValidLonLat(p) ? haversineMeters(input, p) : null;
    const sim = hasName
      ? Math.max(similarity(norm(p.name_ar ?? ''), name), similarity(norm(p.name_latin ?? ''), name))
      : null;

    const sameType = p.type === input.type || p.type === 'combined' || input.type === 'combined';
    const near = !!input.type && distance !== null && distance <= radius && sameType;
    const sameVillage = input.localityId
      ? p.locality_id === input.localityId
      : distance !== null && distance <= SAME_VILLAGE_RADIUS_M;
    const named = sim !== null && sim >= minSim && sameVillage;
    if (!near && !named) continue;

    hits.push({
      id: p.id,
      code: p.code,
      name_ar: p.name_ar,
      name_latin: p.name_latin,
      type: p.type,
      status: p.status,
      record_state: p.record_state,
      lon: p.lon,
      lat: p.lat,
      locality_id: p.locality_id,
      admin_area_id: p.admin_area_id,
      created_by_me: !!userId && p.created_by === userId,
      distance_m: distance === null ? null : Math.round(distance * 10) / 10,
      similarity: sim === null ? null : Math.round(sim * 1000) / 1000,
      reason: near && named ? 'both' : near ? 'nearby' : 'similar_name',
    });
  }

  const rank = (h: DuplicateHit): number => (h.reason === 'both' ? 0 : h.reason === 'nearby' ? 1 : 2);
  hits.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity) ||
      (b.similarity ?? -1) - (a.similarity ?? -1) ||
      (a.id < b.id ? -1 : 1),
  );
  return hits.slice(0, MAX_DUPLICATES);
}

// ---------------------------------------------------------------------------------------
// Persons
// ---------------------------------------------------------------------------------------

export interface PersonCandidate {
  id: string;
  name_ar: string | null;
  name_latin: string | null;
  /** Never masked locally: persons on the device are inside the user's people scope. */
  phone: string | null;
  phone_masked: false;
  gender: Row<'persons'>['gender'];
  birth_year: number | null;
  home_area: {
    id: string | null;
    name_ar: string | null;
    name_en: string | null;
    name_sw: string | null;
    text: string | null;
  } | null;
  /** Distinct roles in projects on the device. */
  roles: Array<Row<'project_staff'>['role']>;
  staff: Array<{
    project_staff_id: string;
    project_id: string;
    project_code: string | null;
    project_name_ar: string;
    project_name_latin: string | null;
    project_type: Row<'projects'>['type'];
    role: Row<'project_staff'>['role'];
    start_date: string | null;
    end_date: string | null;
  }>;
  /** Assignments whose project is not on the device. */
  hidden_projects: number;
  /** Best of the Arabic and the Latin name; null when no name was given. */
  similarity: number | null;
  same_area: boolean;
  /** Non-empty subset of `phone`, `name`, `area`, in this order. */
  reasons: Array<'phone' | 'name' | 'area'>;
}

const NAME_POOL = 40;
const MAX_CANDIDATES = 12;
/** Index keys read per word when collecting name candidates. */
const WORD_KEY_BUDGET = 400;

/** E.164 form of a typed phone number (digits kept, `00` = `+`), or null. */
export function normalizePhone(phone: string | null | undefined): string | null {
  let raw = (phone ?? '').replace(/[^0-9+]/g, '');
  if (raw.startsWith('00')) raw = '+' + raw.slice(2);
  const digits = raw.replace(/[^0-9]/g, '');
  return digits.length >= 7 && digits.length <= 15 ? '+' + digits : null;
}

/** Similarity of a typed name with a person: each script separately, the best one counts. */
function personSimilarity(p: Row<'persons'>, name: string): number {
  return Math.max(
    p.name_ar ? similarity(norm(p.name_ar), name) : 0,
    p.name_latin ? similarity(norm(p.name_latin), name) : 0,
  );
}

async function nameCandidates(name: string, threshold: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const nameWords = words(name);
  if (nameWords.length === 0) return out;

  if (nameWords.length === 1) {
    // One word can only reach the threshold against a name that IS that word: equality.
    const ids = (await db.persons.where('_tokens').equals(name).limit(WORD_KEY_BUDGET).primaryKeys()) as string[];
    const rows = (await db.persons.bulkGet([...new Set(ids)].slice(0, NAME_POOL * 4))) as Array<StoredPerson | undefined>;
    for (const p of rows) {
      if (!p || p.merged_into_id) continue;
      if (norm(p.name_ar ?? '') === name || norm(p.name_latin ?? '') === name) out.set(p.id, 1);
    }
    return out;
  }

  // Several words: persons sharing word beginnings with the typed name are the candidates
  // (a name that is >= 0.6 similar shares most of its words, typos included). Rank them by
  // the number of shared words and compare only the best ones — bounded reads however
  // common the name is.
  const votes = new Map<string, number>();
  // Prefix of the word without the Arabic article (the index holds both forms), so that
  // "al-" does not make every prefix the same.
  const prefixes = [
    ...new Set(nameWords.filter((w) => w.length >= 2).map((w) => (stripArabicArticle(w) ?? w).slice(0, 3))),
  ];
  for (const prefix of prefixes) {
    const ids = (await db.persons.where('_tokens').startsWith(prefix).limit(WORD_KEY_BUDGET).primaryKeys()) as string[];
    // A prefix that fills the budget is too common to tell anything: a whole vote only for
    // the selective ones.
    const weight = ids.length < WORD_KEY_BUDGET ? 2 : 1;
    for (const id of new Set(ids)) votes.set(id, (votes.get(id) ?? 0) + weight);
  }
  const best = [...votes.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, NAME_POOL * 3)
    .map(([id]) => id);
  const rows = (await db.persons.bulkGet(best)) as Array<StoredPerson | undefined>;
  for (const p of rows) {
    if (!p || p.merged_into_id) continue;
    const sim = personSimilarity(p, name);
    if (sim >= threshold) out.set(p.id, sim);
  }
  return out;
}

/**
 * "Possible matching persons" for the staff form, best first (max 12):
 *   - phone: the typed number equals `phone_e164`;
 *   - name: trigram similarity >= setting `persons.name_similarity` (default 0.6) with the
 *     Arabic or the Latin name; a single word is matched by equality; fewer than two
 *     characters: no name search;
 *   - area (ranking only): the person's home area is the given area, one of its ancestors
 *     or inside it, or the person works in a project located in that area.
 * Order: phone matches, same area, similarity, name. NEVER merges anything.
 */
export async function findLocalPersonCandidates(input: {
  name: string;
  phone?: string;
  adminAreaId?: string | null;
}): Promise<PersonCandidate[]> {
  const threshold = await getNumberSetting('persons.name_similarity', 0.6, 0.4, 1);
  const name = norm(input.name ?? '');
  const phone = normalizePhone(input.phone);
  const useName = name.length >= 2;
  if (!useName && !phone) return [];

  return db.transaction('r', [db.persons, db.project_staff, db.projects, db.admin_areas], async () => {
    const found = new Map<string, { byPhone: boolean; sim: number | null }>();
    if (phone) {
      const rows = await db.persons.where('phone_e164').equals(phone).toArray();
      for (const p of rows) {
        if (!p.merged_into_id) found.set(p.id, { byPhone: true, sim: null });
      }
    }
    if (useName) {
      for (const [id, sim] of await nameCandidates(name, threshold)) {
        const entry = found.get(id);
        if (entry) entry.sim = sim;
        else found.set(id, { byPhone: false, sim });
      }
    }
    if (found.size === 0) return [];

    const requestedChain = input.adminAreaId ? await areaChain(input.adminAreaId) : [];
    const persons = (await db.persons.bulkGet([...found.keys()])) as Array<Row<'persons'> | undefined>;
    const out: PersonCandidate[] = [];

    for (const p of persons) {
      if (!p) continue;
      const entry = found.get(p.id)!;
      const sim = useName ? (entry.sim ?? personSimilarity(p, name)) : null;

      const links = await db.project_staff.where('person_id').equals(p.id).toArray();
      const projects = await db.projects.bulkGet(links.map((l) => l.project_id));
      const staff: PersonCandidate['staff'] = [];
      let hidden = 0;
      let worksInArea = false;
      links.forEach((l, i) => {
        const pr = projects[i];
        if (!pr) {
          hidden++;
          return;
        }
        if (input.adminAreaId && pr.admin_area_id === input.adminAreaId) worksInArea = true;
        staff.push({
          project_staff_id: l.id,
          project_id: pr.id,
          project_code: pr.code,
          project_name_ar: pr.name_ar,
          project_name_latin: pr.name_latin,
          project_type: pr.type,
          role: l.role,
          start_date: l.start_date,
          end_date: l.end_date,
        });
      });
      staff.sort(
        (a, b) =>
          Number(a.end_date !== null) - Number(b.end_date !== null) ||
          (b.end_date ?? '').localeCompare(a.end_date ?? '') ||
          (b.start_date ?? '').localeCompare(a.start_date ?? '') ||
          (a.project_staff_id < b.project_staff_id ? -1 : 1),
      );

      let homeInArea = false;
      let home: PersonCandidate['home_area'] = null;
      if (p.home_admin_area_id || p.home_area_text) {
        const area = p.home_admin_area_id ? await db.admin_areas.get(p.home_admin_area_id) : undefined;
        home = {
          id: p.home_admin_area_id,
          name_ar: area?.name_ar ?? null,
          name_en: area?.name_en ?? null,
          name_sw: area?.name_sw ?? null,
          text: p.home_area_text,
        };
        if (input.adminAreaId && p.home_admin_area_id) {
          const homeChain = await areaChain(p.home_admin_area_id);
          homeInArea =
            requestedChain.includes(p.home_admin_area_id) || // the area itself or one of its ancestors
            homeChain.includes(input.adminAreaId); // home lies inside the requested area
        }
      }

      const sameArea = homeInArea || worksInArea;
      const byName = sim !== null && sim >= threshold;
      const reasons: PersonCandidate['reasons'] = [];
      if (entry.byPhone) reasons.push('phone');
      if (byName) reasons.push('name');
      if (sameArea) reasons.push('area');

      out.push({
        id: p.id,
        name_ar: p.name_ar,
        name_latin: p.name_latin,
        phone: p.phone_e164,
        phone_masked: false,
        gender: p.gender,
        birth_year: p.birth_year,
        home_area: home,
        roles: [...new Set(staff.map((s) => s.role))],
        staff,
        hidden_projects: hidden,
        similarity: sim === null ? null : Math.round(sim * 1000) / 1000,
        same_area: sameArea,
        reasons,
      });
    }

    out.sort(
      (a, b) =>
        Number(b.reasons.includes('phone')) - Number(a.reasons.includes('phone')) ||
        Number(b.same_area) - Number(a.same_area) ||
        (b.similarity ?? -1) - (a.similarity ?? -1) ||
        (a.name_ar ?? '').localeCompare(b.name_ar ?? '') ||
        (a.id < b.id ? -1 : 1),
    );
    return out.slice(0, MAX_CANDIDATES);
  });
}
