/**
 * Completeness score of a project (0..100): the twin of SQL `private.project_completeness`
 * (docs/contracts/schema.md, section 5). The server recomputes and stores the authoritative
 * value; this function gives the same number offline, e.g. for the form indicator and the
 * "incomplete records" list of rows that are not synced yet.
 */
import type { ProjectBundle } from '../db/bundle';
import type { ProjectRow } from '../db/types';

export const COMPLETENESS_WEIGHTS = {
  name_ar: 10,
  name_latin: 5,
  location: 15,
  admin_area: 5,
  capacity: 5,
  build_year: 5,
  photos: 15,
  land: 10,
  facilities: 10,
  staff: 10,
  community: 10,
} as const;

export type CompletenessKey = keyof typeof COMPLETENESS_WEIGHTS;

/** Which live child rows exist (restricted tables are not part of the score). */
export interface CompletenessChildren {
  photos: boolean;
  land: boolean;
  facilities: boolean;
  staff: boolean;
  community: boolean;
}

export type CompletenessProject = Pick<
  ProjectRow,
  'name_ar' | 'name_latin' | 'lon' | 'lat' | 'admin_area_id' | 'capacity' | 'build_year' | 'build_date'
>;

/** PostgreSQL `btrim(text)` removes blanks only (not tabs or line breaks). */
function notBlank(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.replace(/^ +| +$/g, '') !== '';
}

const isLive = (row: { deleted_at?: string | null } | null | undefined): boolean =>
  !!row && (row.deleted_at === null || row.deleted_at === undefined);

/** The satisfied conditions, key by key. */
export function completenessParts(
  project: CompletenessProject,
  children: CompletenessChildren,
): Record<CompletenessKey, boolean> {
  return {
    name_ar: notBlank(project.name_ar),
    name_latin: notBlank(project.name_latin),
    location: typeof project.lon === 'number' && typeof project.lat === 'number',
    admin_area: project.admin_area_id !== null && project.admin_area_id !== undefined,
    capacity: typeof project.capacity === 'number' && project.capacity > 0,
    // The server fills build_year from build_date before it scores the row.
    build_year:
      (project.build_year !== null && project.build_year !== undefined) ||
      (project.build_date !== null && project.build_date !== undefined && project.build_date !== ''),
    photos: children.photos,
    land: children.land,
    facilities: children.facilities,
    staff: children.staff,
    community: children.community,
  };
}

/** Sum of the weights whose condition holds. */
export function completenessScore(project: CompletenessProject, children: CompletenessChildren): number {
  const parts = completenessParts(project, children);
  let score = 0;
  for (const key of Object.keys(COMPLETENESS_WEIGHTS) as CompletenessKey[]) {
    if (parts[key]) score += COMPLETENESS_WEIGHTS[key];
  }
  return score;
}

export function bundleChildren(bundle: ProjectBundle): CompletenessChildren {
  return {
    photos: bundle.photos.some(isLive),
    land: isLive(bundle.land),
    facilities: isLive(bundle.facilities),
    staff: bundle.staff.some(isLive),
    community: isLive(bundle.community),
  };
}

/** Completeness (0..100) of a project as the server will compute it once the bundle is synced. */
export function projectCompleteness(bundle: ProjectBundle): number {
  return completenessScore(bundle.project, bundleChildren(bundle));
}

/** Keys that are still missing, heaviest first (for "what is left to fill in" hints). */
export function missingCompletenessKeys(bundle: ProjectBundle): CompletenessKey[] {
  const parts = completenessParts(bundle.project, bundleChildren(bundle));
  return (Object.keys(COMPLETENESS_WEIGHTS) as CompletenessKey[])
    .filter((k) => !parts[k])
    .sort((a, b) => COMPLETENESS_WEIGHTS[b] - COMPLETENESS_WEIGHTS[a]);
}
