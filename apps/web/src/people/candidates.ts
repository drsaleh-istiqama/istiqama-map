/**
 * "Possible matching persons" (brief §2.4): the offline list of `findLocalPersonCandidates`
 * (src/db) combined with the server's `person_candidates` (docs/contracts/people-admin.md §3).
 *
 * Pure functions only. NOTHING here links, merges or creates a person — the user decides
 * between "same person" and "new person".
 */
import type { PersonCandidate } from '../db';

export type MatchReason = 'phone' | 'name' | 'area';

/** One element of `person_candidates()` (phones masked when the caller may not see them). */
export interface ServerCandidate extends Omit<PersonCandidate, 'phone_masked'> {
  phone_masked: boolean;
}

/** A candidate as the picker shows it. */
export interface Candidate extends Omit<PersonCandidate, 'phone_masked'> {
  phone_masked: boolean;
  /** Where the candidate was found. */
  origin: 'local' | 'server' | 'both';
}

/** Same cap as the server and the local twin. */
export const MAX_CANDIDATES = 12;

const REASON_ORDER: readonly MatchReason[] = ['phone', 'name', 'area'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Validates the server answer defensively: malformed elements are dropped instead of
 * breaking the form (the local list is still shown).
 */
export function parseServerCandidates(data: unknown): ServerCandidate[] {
  if (!Array.isArray(data)) return [];
  const out: ServerCandidate[] = [];
  for (const raw of data) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue;
    const home = isRecord(raw.home_area) ? raw.home_area : null;
    const staff = Array.isArray(raw.staff) ? raw.staff.filter(isRecord) : [];
    const reasons = Array.isArray(raw.reasons)
      ? REASON_ORDER.filter((r) => (raw.reasons as unknown[]).includes(r))
      : [];
    out.push({
      id: raw.id,
      name_ar: str(raw.name_ar),
      name_latin: str(raw.name_latin),
      phone: str(raw.phone),
      phone_masked: raw.phone_masked === true,
      gender: raw.gender === 'male' || raw.gender === 'female' ? raw.gender : null,
      birth_year: num(raw.birth_year),
      home_area: home
        ? {
            id: str(home.id),
            name_ar: str(home.name_ar),
            name_en: str(home.name_en),
            name_sw: str(home.name_sw),
            text: str(home.text),
          }
        : null,
      roles: (Array.isArray(raw.roles) ? raw.roles : []).filter(
        (r): r is PersonCandidate['roles'][number] => typeof r === 'string',
      ),
      staff: staff.map((s) => ({
        project_staff_id: String(s.project_staff_id ?? ''),
        project_id: String(s.project_id ?? ''),
        project_code: str(s.project_code),
        project_name_ar: String(s.project_name_ar ?? ''),
        project_name_latin: str(s.project_name_latin),
        project_type: s.project_type as PersonCandidate['staff'][number]['project_type'],
        role: s.role as PersonCandidate['staff'][number]['role'],
        start_date: str(s.start_date),
        end_date: str(s.end_date),
      })),
      hidden_projects: num(raw.hidden_projects) ?? 0,
      similarity: num(raw.similarity),
      same_area: raw.same_area === true,
      reasons,
    });
  }
  return out;
}

/** The ranking of the contract: phone matches, same area, similarity (desc), name, id. */
export function rankCandidates<T extends Omit<Candidate, 'origin'>>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) =>
      Number(b.reasons.includes('phone')) - Number(a.reasons.includes('phone')) ||
      Number(b.same_area) - Number(a.same_area) ||
      (b.similarity ?? -1) - (a.similarity ?? -1) ||
      (a.name_ar ?? a.name_latin ?? '').localeCompare(b.name_ar ?? b.name_latin ?? '') ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Local and server candidates in one list, each person once.
 *   - the device copy wins for names, phone (never masked locally) and home area: it may
 *     carry edits that are not uploaded yet;
 *   - match reasons and assignments are united (the server knows projects outside the
 *     device, the device knows assignments not uploaded yet);
 *   - a person the server does not know yet (created offline) stays in the list.
 */
export function combineCandidates(
  local: readonly PersonCandidate[],
  server: readonly ServerCandidate[] | null | undefined,
  max = MAX_CANDIDATES,
): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const c of local) byId.set(c.id, { ...c, origin: 'local' });
  for (const s of server ?? []) {
    const mine = byId.get(s.id);
    if (!mine) {
      byId.set(s.id, { ...s, origin: 'server' });
      continue;
    }
    const staff = [...mine.staff];
    for (const entry of s.staff) {
      if (!staff.some((x) => x.project_staff_id === entry.project_staff_id)) staff.push(entry);
    }
    const sims = [mine.similarity, s.similarity].filter((x): x is number => x !== null);
    byId.set(s.id, {
      ...mine,
      phone: mine.phone ?? s.phone,
      phone_masked: mine.phone ? false : s.phone_masked,
      home_area: mine.home_area ?? s.home_area,
      roles: [...new Set([...mine.roles, ...s.roles])],
      staff,
      hidden_projects: Math.max(0, Math.min(mine.hidden_projects, s.hidden_projects)),
      similarity: sims.length > 0 ? Math.max(...sims) : null,
      same_area: mine.same_area || s.same_area,
      reasons: REASON_ORDER.filter((r) => mine.reasons.includes(r) || s.reasons.includes(r)),
      origin: 'both',
    });
  }
  return rankCandidates([...byId.values()]).slice(0, max);
}

/** Text typed in the name box: which name field it most likely belongs to. */
export function scriptOf(text: string): 'arabic' | 'latin' | 'none' {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    // Arabic, Arabic Supplement, Arabic Extended-A
    if (
      (c >= 0x0600 && c <= 0x06ff) ||
      (c >= 0x0750 && c <= 0x077f) ||
      (c >= 0x08a0 && c <= 0x08ff)
    )
      return 'arabic';
  }
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f))
      return 'latin';
  }
  return 'none';
}
