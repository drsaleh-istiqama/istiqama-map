/**
 * Acceptance criterion 4 of the brief (§14.4) — field-level conflict resolution:
 *
 *   two devices (two persistent Chrome profiles of the same collector, i.e. two device ids)
 *   hold the same project;
 *   A. both edit the SAME field offline → both sync → the server records one open conflict
 *      → the branch supervisor sees it on the review page and resolves it ("keep client");
 *   B. both edit DIFFERENT fields offline → both sync → merged automatically, no conflict.
 *
 * Everything goes through the real form and the real sync engine; the server state is checked
 * with the service role. The project is soft-deleted at the end.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  appNavigate,
  firstPage,
  launchDevice,
  localRow,
  newProfileDir,
  observe,
  removeProfile,
  runTag,
  SCREENS_DIR,
  saveProjectForm,
  serviceSelect,
  signIn,
  softDeleteRows,
  syncOnce,
  unexpectedErrors,
  visible,
  waitFirstSync,
  waitSynced,
} from './helpers';

const COLLECTOR = 'collector.pemba@example.org';
const SUPERVISOR = 'supervisor.pemba@example.org';
/** North Pemba, away from the seeded projects and from the field scenario's grid. */
const POINT = { latitude: -5.042, longitude: 39.776, accuracy: 4 };

interface ServerProject {
  id: string;
  name_ar: string;
  name_latin: string | null;
  version: number;
  record_state: string;
}
interface ServerConflict {
  id: string;
  field: string;
  state: string;
  server_value: unknown;
  client_value: unknown;
}

async function serverProject(
  request: Parameters<typeof serviceSelect>[0],
  id: string,
): Promise<ServerProject> {
  const rows = await serviceSelect<ServerProject>(
    request,
    `projects?select=id,name_ar,name_latin,version,record_state&id=eq.${id}`,
  );
  expect(rows).toHaveLength(1);
  return rows[0] as ServerProject;
}

function conflictsOf(request: Parameters<typeof serviceSelect>[0], id: string) {
  return serviceSelect<ServerConflict>(
    request,
    `sync_conflicts?select=id,field,state,server_value,client_value&row_id=eq.${id}&order=created_at`,
  );
}

/** Opens the edit form of a stored project (in-app, works offline) and changes one text field. */
async function editText(page: Page, id: string, testId: string, value: string): Promise<void> {
  await appNavigate(page, `/projects/${id}/edit`);
  await expect(page.getByTestId('project-form')).toBeVisible();
  await expect(page.getByTestId('form-name')).not.toHaveValue('');
  await page.getByTestId(testId).fill(value);
  const { id: saved } = await saveProjectForm(page, 'form-save-draft');
  expect(saved).toBe(id);
}

/** Waits until this device's copy of the project shows `name` (after a pull). */
async function expectLocalName(page: Page, id: string, name: string): Promise<void> {
  await appNavigate(page, `/projects/${id}`);
  await expect(page.getByTestId('details-name')).toContainText(name, { timeout: 30_000 });
}

test('conflicts: same field → supervisor decides; different fields → merged', async ({
  request,
}) => {
  test.setTimeout(20 * 60_000);
  const tag = runTag();
  const base = `مسجد التعارض ${tag}`;
  const dirs = { a: newProfileDir('conf-a'), b: newProfileDir('conf-b'), s: newProfileDir('sup') };
  const contexts: BrowserContext[] = [];
  let projectId: string | null = null;
  try {
    // --- device A creates a draft online and uploads it -----------------------------------------
    const ctxA = await launchDevice(dirs.a, { geolocation: POINT });
    contexts.push(ctxA);
    const a = await firstPage(ctxA);
    const seenA = await observe(ctxA, a);
    await signIn(a, request, COLLECTOR);
    await waitFirstSync(a);

    await visible(a, 'add-project').click();
    await expect(a.getByTestId('project-form')).toBeVisible();
    await a.getByTestId('form-type-mosque').click();
    await a.getByTestId('form-name').fill(base);
    await a.getByTestId('form-gps').click();
    await expect(a.getByTestId('form-area')).not.toHaveValue('', { timeout: 30_000 });
    ({ id: projectId } = await saveProjectForm(a, 'form-save-draft'));
    const id = projectId;
    await waitSynced(a);
    const created = await serverProject(request, id);
    expect(created.name_ar).toBe(base);
    expect(created.record_state).toBe('draft');

    // --- device B (same user, second phone) pulls it --------------------------------------------
    const ctxB = await launchDevice(dirs.b, { geolocation: POINT });
    contexts.push(ctxB);
    const b = await firstPage(ctxB);
    const seenB = await observe(ctxB, b);
    await signIn(b, request, COLLECTOR);
    await waitFirstSync(b);
    await expectLocalName(b, id, base);

    // --- A. the SAME field on both devices, offline ---------------------------------------------
    const nameA = `${base} أ`;
    const nameB = `${base} ب`;
    await ctxA.setOffline(true);
    await ctxB.setOffline(true);
    await editText(a, id, 'form-name', nameA);
    await editText(b, id, 'form-name', nameB);

    await ctxA.setOffline(false);
    await waitSynced(a);
    expect((await serverProject(request, id)).name_ar).toBe(nameA);

    await ctxB.setOffline(false);
    await waitSynced(b);
    const open = (await conflictsOf(request, id)).filter((c) => c.state === 'open');
    expect(open, 'one open conflict on the name').toHaveLength(1);
    expect(open[0]).toMatchObject({ field: 'name_ar', server_value: nameA, client_value: nameB });
    // The server kept A's value; B's device shows it until the supervisor decides.
    expect((await serverProject(request, id)).name_ar).toBe(nameA);
    await expectLocalName(b, id, nameA);

    // --- the supervisor sees the conflict and keeps the client's value --------------------------
    const ctxS = await launchDevice(dirs.s);
    contexts.push(ctxS);
    const s = await firstPage(ctxS);
    const seenS = await observe(ctxS, s);
    await signIn(s, request, SUPERVISOR);
    await waitFirstSync(s);
    await visible(s, 'nav-review').click();
    await expect(s.getByTestId('review-page')).toBeVisible();
    await s.getByTestId('review-tab-conflicts').click();
    const row = s
      .getByTestId('conflict-row')
      .filter({ has: s.getByTestId('conflict-client-value').filter({ hasText: nameB }) });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row.getByTestId('conflict-server-value')).toContainText(nameA);
    await expect(row).toHaveAttribute('data-field', 'name_ar');
    await s.screenshot({ path: `${SCREENS_DIR}/review.png`, fullPage: true });
    await row.getByTestId('conflict-keep-client').click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });

    await expect
      .poll(async () => (await conflictsOf(request, id)).map((c) => c.state))
      .toEqual(['resolved_client']);
    expect((await serverProject(request, id)).name_ar).toBe(nameB);

    // Both phones receive the decision.
    await syncOnce(a);
    await syncOnce(b);
    await expectLocalName(a, id, nameB);
    await expectLocalName(b, id, nameB);

    // --- B. DIFFERENT fields on both devices, offline → merged ----------------------------------
    const nameA2 = `${base} أ2`;
    const latinB2 = `Msikiti ${tag} B2`;
    await ctxA.setOffline(true);
    await ctxB.setOffline(true);
    await editText(a, id, 'form-name', nameA2);
    await editText(b, id, 'form-name-latin', latinB2);

    await ctxA.setOffline(false);
    await waitSynced(a);
    await ctxB.setOffline(false);
    await waitSynced(b);

    const merged = await serverProject(request, id);
    expect(merged.name_ar, "A's field").toBe(nameA2);
    expect(merged.name_latin, "B's field").toBe(latinB2);
    expect(merged.record_state).toBe('draft');
    const all = await conflictsOf(request, id);
    expect(
      all.map((c) => c.state),
      'no new conflict for disjoint fields',
    ).toEqual(['resolved_client']);
    // Both phones end with the merged row (the details title shows the Latin name in a
    // Swahili / English interface, so compare the stored row itself).
    for (const device of [a, b]) {
      await syncOnce(device);
      await expect
        .poll(async () => {
          const row = await localRow<{ name_ar?: string; name_latin?: string }>(
            device,
            'projects',
            id,
          );
          return [row?.name_ar, row?.name_latin];
        })
        .toEqual([nameA2, latinB2]);
    }

    for (const [who, seen] of [
      ['A', seenA],
      ['B', seenB],
      ['supervisor', seenS],
    ] as const) {
      expect(unexpectedErrors(seen.consoleErrors), `console errors on ${who}`).toEqual([]);
      expect(seen.cspViolations, `CSP on ${who}`).toEqual([]);
      expect(seen.foreignRequests, `foreign requests on ${who}`).toEqual([]);
    }
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    for (const dir of Object.values(dirs)) removeProfile(dir);
    const leftovers = await serviceSelect<{ id: string }>(
      request,
      `projects?select=id&name_ar=like.*${encodeURIComponent(tag)}`,
    ).catch(() => []);
    const ids = [...new Set([...leftovers.map((p) => p.id), ...(projectId ? [projectId] : [])])];
    await softDeleteRows(request, 'projects', 'id', ids).catch(() => 0);
  }
});
