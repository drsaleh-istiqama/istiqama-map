import { useState } from 'preact/hooks';
import { projectCompleteness } from '../lib/completeness';
import { Gallery } from '../photos';
import { fmt, pickName, t } from '../i18n';
import { navigate, useRoute } from '../routes';
import { Button, confirm, EmptyState, Link, Spinner, toast, useLiveQuery } from '../ui';
import {
  BasicSection,
  CommunitySection,
  DonorsSection,
  FacilitiesSection,
  LandSection,
  LocationSection,
  MetaSection,
  SensitiveSection,
  Section,
  StaffSection,
} from './DetailsSections';
import { RecordStateBadge, StatusBadge, TypeIcon, typeLabel } from './labels';
import { MaintenanceSection } from './MaintenanceSection';
import {
  canApprove,
  canDeleteProject,
  canEditProject,
  canReturn,
  canSubmit,
  currentActor,
  type Actor,
} from './permissions';
import { loadProjectDetails, type ProjectDetails } from './queries';
import { approveProject, deleteProject, returnProject, submitProject } from './review';
import { ReturnDialog } from './ReturnDialog';
import './projects.css';

/** Sync state of this record on this device. */
export function syncStateOf(details: ProjectDetails): 'failed' | 'conflict' | 'pending' | 'synced' {
  const p = details.bundle.project;
  if (details.sync.failedOps > 0 || p._failed === 1) return 'failed';
  if (details.sync.openConflicts > 0 || p._conflict === 1) return 'conflict';
  if (details.sync.pendingOps > 0 || p._dirty === 1) return 'pending';
  return 'synced';
}

function SyncLine({ details }: { details: ProjectDetails }) {
  const state = syncStateOf(details);
  const text =
    state === 'synced'
      ? t('projects.syncSynced')
      : state === 'pending'
        ? t('projects.syncPending', { count: fmt.number(Math.max(1, details.sync.pendingOps)) })
        : state === 'conflict'
          ? t('projects.syncConflict')
          : t('projects.syncFailed');
  return (
    <span class="pdetails__sync" data-testid="details-sync" data-state={state}>
      {text}
    </span>
  );
}

function Header({ details }: { details: ProjectDetails }) {
  const { bundle } = details;
  const p = bundle.project;
  const completeness = p._dirty === 1 ? projectCompleteness(bundle) : p.completeness;
  const place = [
    details.locality ? pickName(details.locality) : '',
    ...details.areas
      .slice()
      .reverse()
      .map((a) => pickName(a)),
    details.country ? pickName(details.country) : '',
  ]
    .filter((s) => s !== '')
    .join(' · ');
  return (
    <header class="pdetails__head on-navy">
      <span class="pdetails__type" data-testid="details-type">
        <TypeIcon type={p.type} size={22} />
        {typeLabel(p.type)}
        {p.code && (
          <span class="pdetails__code ltr" dir="ltr" data-testid="details-code">
            {p.code}
          </span>
        )}
      </span>
      <h2 class="pdetails__name" data-testid="details-name">
        <bdi>{pickName(p)}</bdi>
      </h2>
      {place && <div class="pdetails__place">{place}</div>}
      <div class="pdetails__badges">
        <StatusBadge status={p.status} testId="details-status" />
        <RecordStateBadge state={p.record_state} testId="details-record-state" />
        <SyncLine details={details} />
      </div>
      <div class="pdetails__meter" data-testid="details-completeness" data-value={completeness}>
        <span>{t('projects.completenessShort', { value: fmt.percent(completeness) })}</span>
        <div
          class="meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={completeness}
          aria-label={t('projects.completenessTitle')}
        >
          <div class="meter__fill" style={{ inlineSize: `${completeness}%` }} />
        </div>
      </div>
    </header>
  );
}

function Notices({ details, actor }: { details: ProjectDetails; actor: Actor }) {
  const p = details.bundle.project;
  const state = syncStateOf(details);
  const migrationNote = p.migration_note?.trim() ?? '';
  return (
    <>
      {migrationNote !== '' && (
        // The v2 migration flag (e.g. salaries given the country's default currency,
        // OWNER_DECISIONS item أ; migration 0073) — reviewers check it before approving.
        <div class="pdetails__notice" role="note" data-testid="details-migration-note">
          <h3>{t('projects.migrationNoteTitle')}</h3>
          <p dir="auto">{migrationNote}</p>
          {actor.review && (
            <p class="muted" data-testid="details-migration-note-hint">
              {t('projects.migrationNoteHint')}
            </p>
          )}
        </div>
      )}
      {p.record_state === 'returned' && (
        <div class="pdetails__notice" role="note" data-testid="details-review-note">
          <h3>{t('projects.returnedNoticeTitle')}</h3>
          <p dir="auto">{p.review_note || t('projects.returnedNoNote')}</p>
        </div>
      )}
      {state === 'conflict' && (
        <div class="pdetails__notice pdetails__notice--info" role="note">
          <p>{t('projects.conflictNotice')}</p>
        </div>
      )}
      {state === 'failed' && (
        <div
          class="pdetails__notice pdetails__notice--danger"
          role="note"
          data-testid="details-failed"
        >
          <p>
            {t('projects.failedNotice')}{' '}
            <Link href="/incomplete">{t('projects.failedNoticeLink')}</Link>
          </p>
        </div>
      )}
    </>
  );
}

function Actions({ details, actor }: { details: ProjectDetails; actor: Actor }) {
  const p = details.bundle.project;
  const [busy, setBusy] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);

  const run = async (key: string, fn: () => Promise<void>, done: string): Promise<boolean> => {
    setBusy(key);
    try {
      await fn();
      toast(done, 'success');
      return true;
    } catch {
      toast(t('projects.actionFailed'), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('projects.deleteTitle'),
      message: t('projects.deleteBody', { name: pickName(p) }),
      confirmLabel: t('projects.deleteConfirm'),
      danger: true,
    });
    if (!ok) return;
    if (await run('delete', () => deleteProject(p.id), t('projects.deleted')))
      navigate('/projects', { replace: true });
  };

  return (
    <div class="pdetails__actions" data-testid="details-actions">
      {canEditProject(p, actor) && (
        <Link href={`/projects/${p.id}/edit`} class="btn btn--primary" testId="details-edit">
          <span class="btn__label">{t('common.edit')}</span>
        </Link>
      )}
      {canSubmit(p, actor) && !actor.review && (
        <Button
          variant="gold"
          testId="details-submit"
          busy={busy === 'submit'}
          onClick={() => void run('submit', () => submitProject(p.id), t('projects.submitted'))}
        >
          {t('projects.submitForReview')}
        </Button>
      )}
      {canApprove(p, actor) && (
        <Button
          variant="gold"
          testId="review-approve"
          busy={busy === 'approve'}
          onClick={() => void run('approve', () => approveProject(p.id), t('projects.approved'))}
        >
          {t('projects.approve')}
        </Button>
      )}
      {canReturn(p, actor) && (
        <Button testId="review-return" busy={busy === 'return'} onClick={() => setReturning(true)}>
          {t('projects.returnToCollector')}
        </Button>
      )}
      <Link
        href={`/reports/print/project/${p.id}`}
        class="btn btn--secondary"
        testId="details-print"
      >
        <span class="btn__label">{t('projects.printCard')}</span>
      </Link>
      {canDeleteProject(p, actor) && (
        <Button
          variant="danger"
          testId="details-delete"
          busy={busy === 'delete'}
          onClick={() => void remove()}
        >
          {t('common.delete')}
        </Button>
      )}
      <ReturnDialog
        open={returning}
        projectName={pickName(p)}
        onCancel={() => setReturning(false)}
        onSubmit={async (note) => {
          await returnProject(p.id, note);
          setReturning(false);
          toast(t('projects.returned'), 'success');
        }}
      />
    </div>
  );
}

/** The details card: everything the device knows about one project. */
export function ProjectDetailsView({ details, actor }: { details: ProjectDetails; actor: Actor }) {
  const { bundle } = details;
  const p = bundle.project;
  return (
    <article class="pdetails" data-testid="project-details" data-id={p.id}>
      <Header details={details} />
      <Notices details={details} actor={actor} />
      <Actions details={details} actor={actor} />
      <BasicSection details={details} />
      <LocationSection project={p} />
      <Section id="photos" title={t('projects.sectionPhotos')} testId="details-photos">
        <Gallery photos={bundle.photos} testId="gallery" />
      </Section>
      <MaintenanceSection
        projectId={p.id}
        entries={bundle.maintenance}
        actor={actor}
        currency={details.country?.default_currency || 'USD'}
      />
      <StaffSection details={details} actor={actor} />
      <DonorsSection bundle={bundle} />
      <LandSection bundle={bundle} actor={actor} />
      <FacilitiesSection bundle={bundle} />
      <CommunitySection details={details} />
      {actor.seeRestricted && <SensitiveSection bundle={bundle} />}
      <MetaSection project={p} actor={actor} />
    </article>
  );
}

/** Route `/projects/:id`: opens from local data only (brief §5: < 300 ms). */
export default function ProjectDetailsPage() {
  const { params } = useRoute();
  const id = params.id ?? '';
  const details = useLiveQuery(async () => (await loadProjectDetails(id)) ?? null, [id]);
  const actor = currentActor();

  return (
    <div class="ppage" data-testid="project-details-page">
      {details === undefined ? (
        <Spinner block />
      ) : details === null ? (
        <EmptyState
          testId="details-not-found"
          title={t('projects.notOnDeviceTitle')}
          message={t('projects.notOnDeviceBody')}
          action={
            <Button variant="primary" onClick={() => navigate('/projects')}>
              {t('projects.backToList')}
            </Button>
          }
        />
      ) : (
        <ProjectDetailsView details={details} actor={actor} />
      )}
    </div>
  );
}
