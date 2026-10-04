/**
 * Route `/projects/new` and `/projects/:id/edit` (web.md §3.9): loads the project (edit) or
 * prepares a blank entry (new), offers to restore an autosaved draft — the edit's own autosave,
 * or on "add project" the newest unfinished new entry (brief §7.4: the draft is restored at the
 * next opening) — lists the other unfinished entries, and renders the form. Everything comes
 * from the device — it works offline.
 */
import { useEffect, useState } from 'preact/hooks';
import { pickName, t } from '../i18n';
import { liveQuery } from 'dexie';
import { db, loadProjectBundle } from '../db';
import { navigate, useRoute } from '../routes';
import { Button, EmptyState, Link, Modal, Spinner, toast } from '../ui';
import { canEdit, formAccess, type FormAccess } from './form/access';
import { discardStoredDraft, listUserDrafts, readDraft, type DraftSummary } from './form/drafts';
import { editDraft, newDraft, type FormDraft } from './form/model';
import { DraftsPanel } from './form/panels';
import { ProjectForm } from './form/ProjectForm';
import { areaPathOf, failedOpsOfProject, getBranch, projectStored } from './form/queries';
import { serverErrors, type FieldErrors } from './form/validate';

type PageState =
  | { status: 'loading' }
  | { status: 'forbidden'; projectId: string | null; rowKey?: string }
  | { status: 'missing' }
  | {
      status: 'ready';
      draft: FormDraft;
      /** Stored autosave of this edit form, waiting for the user's decision. */
      restore: FormDraft | null;
      /**
       * `/projects/new` without `?draft=`: the newest unfinished new entry, offered before a
       * blank form (continue it — the default — or start another project and keep it listed).
       */
      resume?: DraftSummary;
      problems?: { fields: FieldErrors; general: string[] };
      others: DraftSummary[];
    };

const newestFirst = (a: DraftSummary, b: DraftSummary): number => b.updatedAt - a.updatedAt;

/**
 * The unfinished new entry to restore when "add project" opens: the newest one of this user
 * (the list is newest first) whose project was not saved meanwhile.
 */
async function unfinishedNewEntry(all: DraftSummary[]): Promise<DraftSummary | undefined> {
  for (const d of all) {
    if (d.draft.mode !== 'new') continue;
    if (await projectStored(d.draft.projectId)) continue;
    return d;
  }
  return undefined;
}

const rowKey = (p: { created_by: string | null; version: number } | undefined): string =>
  p ? `${p.created_by ?? ''}|${p.version}` : '';

async function freshNewDraft(access: FormAccess): Promise<FormDraft> {
  const branchId = access.branches.length === 1 ? access.branches[0]! : null;
  const branch = branchId ? await getBranch(branchId) : undefined;
  const countryId =
    branch?.country_id ?? (access.countries.length === 1 ? access.countries[0]! : null);
  return newDraft({ userId: access.userId, countryId, branchId });
}

export async function prepareForm(
  access: FormAccess,
  projectId: string | null,
  resumeId: string | null,
): Promise<PageState> {
  if (!access.write) return { status: 'forbidden', projectId };
  if (projectId) {
    const bundle = await loadProjectBundle(projectId);
    if (!bundle) return { status: 'missing' };
    if (!canEdit(bundle.project, access))
      return { status: 'forbidden', projectId, rowKey: rowKey(bundle.project) };
    const draft = editDraft(bundle, access.userId);
    draft.extras.areaPath = await areaPathOf(bundle.project.admin_area_id);
    if (typeof bundle.project.lon === 'number' && typeof bundle.project.lat === 'number') {
      // The stored area belongs to the stored point: do not re-fill it on opening.
      draft.extras.geofillFor = { lon: bundle.project.lon, lat: bundle.project.lat };
    }
    const failed = await failedOpsOfProject(projectId);
    const restore = await readDraft('edit', projectId, access.userId);
    const others = (await listUserDrafts(access.userId)).filter(
      (d) => d.draft.projectId !== projectId,
    );
    return {
      status: 'ready',
      draft,
      restore,
      problems: failed.length > 0 ? serverErrors(failed) : undefined,
      others,
    };
  }
  const resumed = resumeId ? await readDraft('new', resumeId, access.userId) : null;
  const all = await listUserDrafts(access.userId);
  // Brief §7.4: what was left unfinished (Esc, back, reload, a closed app) comes back at the
  // next opening — never a silent blank form next to it, which would start a second draft.
  const resume = resumed ? undefined : await unfinishedNewEntry(all);
  const draft = resumed ?? (await freshNewDraft(access));
  const others = all.filter((d) => d.draft.projectId !== draft.projectId && d.key !== resume?.key);
  return { status: 'ready', draft, restore: null, ...(resume ? { resume } : {}), others };
}

export default function ProjectFormPage() {
  const route = useRoute();
  const access = formAccess();
  const projectId = route.params.id ?? null;
  const resumeId = route.query.get('draft');
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    prepareForm(access, projectId, resumeId).then(
      (s) => alive && setState(s),
      (error: unknown) => {
        console.error('[form] could not open the form', error);
        if (alive) setState({ status: 'missing' });
      },
    );
    return () => {
      alive = false;
    };
  }, [projectId, resumeId, access.userId, access.write, retry]);

  // A record entered on this device carries its creator only after the next pull: while the
  // page says "not yours", look again whenever the stored row changes.
  const watchId =
    state.status === 'forbidden' && state.rowKey !== undefined && projectId ? projectId : null;
  const seenKey = state.status === 'forbidden' ? (state.rowKey ?? '') : '';
  useEffect(() => {
    if (!watchId) return;
    const sub = liveQuery(() => db.projects.get(watchId)).subscribe({
      next: (row) => {
        if (rowKey(row) !== seenKey) setRetry((n) => n + 1);
      },
      error: () => undefined,
    });
    return () => sub.unsubscribe();
  }, [watchId, seenKey]);

  if (state.status === 'loading') {
    return (
      <div class="page" aria-busy="true">
        <Spinner />
      </div>
    );
  }
  if (state.status === 'forbidden') {
    return (
      <div class="page">
        <EmptyState
          testId="form-forbidden"
          title={projectId ? t('form.cannotEditTitle') : t('form.cannotCreateTitle')}
          message={projectId ? t('form.cannotEdit') : t('form.cannotCreate')}
          action={
            state.projectId ? (
              <Link href={`/projects/${state.projectId}`}>{t('form.openDetails')}</Link>
            ) : undefined
          }
        />
      </div>
    );
  }
  if (state.status === 'missing') {
    return (
      <div class="page">
        <EmptyState
          testId="form-missing"
          title={t('form.notOnDeviceTitle')}
          message={t('form.notOnDevice')}
          action={<Link href="/projects">{t('form.backToList')}</Link>}
        />
      </div>
    );
  }

  const { draft, restore, resume, problems, others } = state;
  const leave = (): void =>
    navigate(draft.mode === 'edit' ? `/projects/${draft.projectId}` : '/projects');

  const resolveRestore = async (useIt: boolean): Promise<void> => {
    if (!restore) return;
    if (useIt) {
      setState({ ...state, draft: restore, restore: null });
    } else {
      await discardStoredDraft(restore);
      setState({ ...state, restore: null });
    }
  };

  const resolveResume = (useIt: boolean): void => {
    if (!resume) return;
    if (useIt) {
      // The URL names the entry, so a reload or the back button reopens the same one.
      navigate(`/projects/new?draft=${resume.draft.projectId}`, { replace: true });
    } else {
      // Another project: the unfinished one stays in the list, nothing is deleted.
      setState({ ...state, resume: undefined, others: [resume, ...others].sort(newestFirst) });
    }
  };
  const resumeName = resume ? pickName(resume.draft.working.project) || t('form.untitled') : '';

  return (
    <div class="page pf-page">
      <DraftsPanel
        items={others}
        onResume={(d) =>
          navigate(
            d.draft.mode === 'edit'
              ? `/projects/${d.draft.projectId}/edit`
              : `/projects/new?draft=${d.draft.projectId}`,
          )
        }
        onDiscard={(d) =>
          void discardStoredDraft(d.draft).then(() => {
            toast(t('form.draftDiscarded'), 'info');
            setState({ ...state, others: others.filter((o) => o.key !== d.key) });
          })
        }
      />
      {restore ? (
        <Modal
          open
          title={t('form.restoreTitle')}
          testId="form-restore-dialog"
          // Closing without a choice keeps the autosaved changes: nothing is dropped silently.
          onClose={() => void resolveRestore(true)}
          footer={
            <>
              <Button testId="form-restore-discard" onClick={() => void resolveRestore(false)}>
                {t('form.restoreDiscard')}
              </Button>
              <Button
                variant="primary"
                testId="form-restore"
                data-autofocus
                onClick={() => void resolveRestore(true)}
              >
                {t('form.restoreUse')}
              </Button>
            </>
          }
        >
          <p>{t('form.restoreBody')}</p>
        </Modal>
      ) : resume ? (
        <Modal
          open
          title={t('form.resumeTitle')}
          testId="form-resume-dialog"
          // Closing without a choice continues the unfinished entry (brief §7.4).
          onClose={() => resolveResume(true)}
          footer={
            <>
              <Button testId="form-resume-new" onClick={() => resolveResume(false)}>
                {t('form.resumeStartNew')}
              </Button>
              <Button
                variant="primary"
                testId="form-resume"
                data-autofocus
                onClick={() => resolveResume(true)}
              >
                {t('form.resumeUse')}
              </Button>
            </>
          }
        >
          <p>{t('form.resumeBody', { name: resumeName })}</p>
        </Modal>
      ) : (
        <ProjectForm
          key={`${draft.mode}:${draft.projectId}`}
          initial={draft}
          access={access}
          serverProblems={problems}
          onSaved={(id) => navigate(`/projects/${id}`, { replace: true })}
          onLeave={leave}
          onOpenProject={(hit) => {
            if (hit.created_by_me || access.review) navigate(`/projects/${hit.id}/edit`);
            else navigate(`/projects/${hit.id}`);
          }}
        />
      )}
    </div>
  );
}
