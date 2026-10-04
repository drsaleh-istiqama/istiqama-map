/**
 * A project with everything that belongs to it, as the form and the details card use it.
 */
import { db } from './dexie';
import type { Row, TableName } from './types';
import { findLocal, mutate, softDelete } from './write';

export interface ProjectBundle {
  project: Row<'projects'>;
  land?: Row<'project_land'>;
  facilities?: Row<'project_facilities'>;
  community?: Row<'community_profiles'>;
  /** Only what this device entered and has not pushed yet, or what a manager pulled. */
  sensitive?: Row<'community_sensitive'>;
  maintenance: Row<'project_maintenance'>[];
  photos: Row<'project_photos'>[];
  donors: Array<Row<'project_donors'> & { donor?: Row<'donors'> }>;
  staff: Array<
    Row<'project_staff'> & { person?: Row<'persons'>; compensation?: Row<'staff_compensation'> }
  >;
}

type AnyRecord = Record<string, unknown>;

const KEEP_LOCAL = new Set([
  '_dirty',
  '_conflict',
  '_conflict_fields',
  '_conflict_version',
  '_failed',
]);

/** The row without index-only fields (tokens, facets, …); the state flags stay. */
export function publicRow<R>(row: R): R {
  const out: AnyRecord = {};
  for (const [k, v] of Object.entries(row as AnyRecord)) {
    if (!k.startsWith('_') || KEEP_LOCAL.has(k)) out[k] = v;
  }
  return out as R;
}

const byCreated = (
  a: { created_at: string; id: string },
  b: { created_at: string; id: string },
): number =>
  a.created_at < b.created_at
    ? -1
    : a.created_at > b.created_at
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

async function oneByProject<
  T extends 'project_land' | 'project_facilities' | 'community_profiles' | 'community_sensitive',
>(table: T, projectId: string): Promise<Row<T> | undefined> {
  const rows = (await db.table(table).where('project_id').equals(projectId).toArray()) as Array<
    Row<T>
  >;
  if (rows.length === 0) return undefined;
  // A second local row exists for a moment when the canonical row of another device arrived
  // while this device's own insert is still queued (the server will redirect it, sync.md
  // §4.2 rule 5). The row with unsent work wins, so the form shows — and later edits fold
  // into — what the user entered; otherwise the newest acknowledged one.
  rows.sort(
    (a, b) =>
      Number(b._dirty === 1) - Number(a._dirty === 1) || b.version - a.version || byCreated(a, b),
  );
  return publicRow(rows[0]!);
}

/**
 * Everything the device knows about a project, read in one consistent snapshot.
 * `undefined` when the project is not on the device (never pulled, deleted, out of scope).
 */
export async function loadProjectBundle(id: string): Promise<ProjectBundle | undefined> {
  return db.transaction('r', db.tables, async () => {
    const project = await db.projects.get(id);
    if (!project) return undefined;

    const [land, facilities, community, maintenance, photos, links, staffRows] = await Promise.all([
      oneByProject('project_land', id),
      oneByProject('project_facilities', id),
      oneByProject('community_profiles', id),
      db.project_maintenance.where('project_id').equals(id).toArray(),
      db.project_photos.where('project_id').equals(id).toArray(),
      db.project_donors.where('project_id').equals(id).toArray(),
      db.project_staff.where('project_id').equals(id).toArray(),
    ]);

    // Restricted: unsent local entries first, then whatever a manager's device pulled.
    const localSensitive = await db.restricted_local
      .where('[table+parent_id]')
      .equals(['community_sensitive', id])
      .first();
    const sensitive =
      (localSensitive?.row as Row<'community_sensitive'> | undefined) ??
      (await oneByProject('community_sensitive', id));

    const donorRows = await db.donors.bulkGet(links.map((l) => l.donor_id));
    const donors = links.sort(byCreated).map((link) => {
      const donor = donorRows.find((d) => d?.id === link.donor_id);
      return { ...publicRow(link), ...(donor ? { donor: publicRow(donor) } : {}) };
    });

    const staffIds = staffRows.map((s) => s.id);
    const persons = await db.persons.bulkGet(staffRows.map((s) => s.person_id));
    const pulledComp = staffIds.length
      ? await db.staff_compensation.where('project_staff_id').anyOf(staffIds).toArray()
      : [];
    const localComp = staffIds.length
      ? await db.restricted_local
          .where('[table+parent_id]')
          .anyOf(staffIds.map((s) => ['staff_compensation', s]))
          .toArray()
      : [];
    const staff = staffRows.sort(byCreated).map((link) => {
      const person = persons.find((p) => p?.id === link.person_id);
      const candidates: Array<Row<'staff_compensation'>> = [
        ...localComp
          .filter((r) => r.parent_id === link.id)
          .map((r) => r.row as Row<'staff_compensation'>),
        ...pulledComp.filter((c) => c.project_staff_id === link.id),
      ];
      // The salary in force: latest effective_from; an unsent local entry wins a tie.
      const compensation = candidates
        .map((c, i) => ({ c, i }))
        .sort((a, b) =>
          a.c.effective_from < b.c.effective_from
            ? 1
            : a.c.effective_from > b.c.effective_from
              ? -1
              : a.i - b.i,
        )[0]?.c;
      return {
        ...publicRow(link),
        ...(person ? { person: publicRow(person) } : {}),
        ...(compensation ? { compensation: publicRow(compensation) } : {}),
      };
    });

    const bundle: ProjectBundle = {
      project: publicRow(project),
      maintenance: maintenance
        .sort((a, b) =>
          a.reported_on < b.reported_on ? 1 : a.reported_on > b.reported_on ? -1 : byCreated(b, a),
        )
        .map(publicRow),
      photos: photos
        .sort((a, b) => Number(b.is_cover) - Number(a.is_cover) || byCreated(a, b))
        .map(publicRow),
      donors,
      staff,
    };
    if (land) bundle.land = land;
    if (facilities) bundle.facilities = facilities;
    if (community) bundle.community = community;
    if (sensitive) bundle.sensitive = publicRow(sensitive);
    return bundle;
  });
}

const isDeleted = (row: { deleted_at?: string | null }): boolean =>
  row.deleted_at !== null && row.deleted_at !== undefined;

/** Insert, update (changed fields only) or delete one row, depending on what is stored. */
async function saveRow<T extends TableName>(
  table: T,
  row: Row<T>,
  storedId?: string,
): Promise<void> {
  const id = storedId ?? row.id;
  const exists = (await findLocal(table, id)) !== undefined;
  if (isDeleted(row)) {
    if (exists) await softDelete(table, id);
    return;
  }
  await mutate(table, id, row as Partial<Row<T>>, { insert: !exists });
}

/**
 * Saves a bundle: compares it with what is stored, row by row and field by field, and calls
 * `mutate()` / `softDelete()` for every difference — all in one transaction, parents before
 * children (project → donors → links → persons → staff → compensation → the rest).
 *
 * Conventions
 *   - `land`, `facilities`, `community`, `sensitive`: `undefined` means "not touched". To
 *     remove such a section pass the row with `deleted_at` set.
 *   - `maintenance`, `photos`, `donors`, `staff`: the arrays are complete — a stored row that
 *     is missing from the array (or carries `deleted_at`) is deleted. Removing a staff or
 *     donor entry deletes the link, never the person or the donor.
 *   - a 1:1 section whose id differs from the stored row of that project updates the stored
 *     row (one live row per project).
 *   - `staff[i].person` / `donors[i].donor` are saved when present (new rows are created
 *     before the link that needs them); `compensation` likewise, `undefined` = not touched.
 * The comparison is against the rows as they are on the device at save time.
 */
export async function saveProjectBundle(next: ProjectBundle): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    const projectId = next.project.id;
    const stored = await loadProjectBundle(projectId);

    await saveRow('projects', next.project);

    // --- donors -----------------------------------------------------------------------
    const nextDonorLinks = new Set(next.donors.filter((d) => !isDeleted(d)).map((d) => d.id));
    for (const old of stored?.donors ?? []) {
      if (!nextDonorLinks.has(old.id)) await softDelete('project_donors', old.id);
    }
    for (const entry of next.donors) {
      if (entry.donor && !isDeleted(entry) && !isDeleted(entry.donor))
        await saveRow('donors', entry.donor);
      await saveRow('project_donors', { ...entry, project_id: projectId });
    }

    // --- staff ------------------------------------------------------------------------
    const nextStaff = new Set(next.staff.filter((s) => !isDeleted(s)).map((s) => s.id));
    for (const old of stored?.staff ?? []) {
      if (!nextStaff.has(old.id)) await softDelete('project_staff', old.id);
    }
    for (const entry of next.staff) {
      if (entry.person && !isDeleted(entry) && !isDeleted(entry.person))
        await saveRow('persons', entry.person);
      await saveRow('project_staff', { ...entry, project_id: projectId });
      if (entry.compensation && !isDeleted(entry)) {
        const comp = { ...entry.compensation, project_staff_id: entry.id };
        const before = stored?.staff.find((s) => s.id === entry.id)?.compensation;
        // Natural key (project_staff_id, effective_from): reuse the stored row for the same date.
        const sameKey =
          before && before.effective_from === comp.effective_from ? before.id : undefined;
        await saveRow('staff_compensation', comp, sameKey);
      }
    }

    // --- one row per project ------------------------------------------------------------
    if (next.land)
      await saveRow('project_land', { ...next.land, project_id: projectId }, stored?.land?.id);
    if (next.facilities) {
      await saveRow(
        'project_facilities',
        { ...next.facilities, project_id: projectId },
        stored?.facilities?.id,
      );
    }
    if (next.community) {
      await saveRow(
        'community_profiles',
        { ...next.community, project_id: projectId },
        stored?.community?.id,
      );
    }
    if (next.sensitive) {
      await saveRow(
        'community_sensitive',
        { ...next.sensitive, project_id: projectId },
        stored?.sensitive?.id,
      );
    }

    // --- lists ------------------------------------------------------------------------
    const nextMaintenance = new Set(next.maintenance.filter((m) => !isDeleted(m)).map((m) => m.id));
    for (const old of stored?.maintenance ?? []) {
      if (!nextMaintenance.has(old.id)) await softDelete('project_maintenance', old.id);
    }
    for (const m of next.maintenance)
      await saveRow('project_maintenance', { ...m, project_id: projectId });

    const nextPhotos = new Set(next.photos.filter((p) => !isDeleted(p)).map((p) => p.id));
    for (const old of stored?.photos ?? []) {
      if (!nextPhotos.has(old.id)) await softDelete('project_photos', old.id);
    }
    for (const p of next.photos) await saveRow('project_photos', { ...p, project_id: projectId });
  });
}
