/**
 * Person card: identity, assignments across projects and roles with their dates, salaries
 * only for restricted access (country manager / HQ), the merge trail for reviewers, and the
 * edit / merge actions the user's role allows.
 */
import { useEffect, useState } from 'preact/hooks';
import { can, me } from '../auth';
import { fmt, pickName, t } from '../i18n';
import {
  Badge,
  Button,
  confirm,
  EmptyState,
  Link,
  Modal,
  Spinner,
  toast,
  useLiveQuery,
} from '../ui';
import { areaChainText } from './AreaPicker';
import { datesText, NameBlock, PhoneText, primaryName } from './display';
import { MergeRequestList } from './MergeRequests';
import {
  formStateOf,
  PersonForm,
  validatePersonForm,
  type PersonFormErrors,
  type PersonFormState,
} from './PersonForm';
import { updatePerson } from './persons';
import {
  defaultDial,
  listCountries,
  loadPersonDetail,
  mergeRequestsOf,
  type MergeRequest,
  type PersonDetail,
} from './queries';
import type { Row } from '../db';

export interface PersonCardProps {
  personId: string;
  onBack: () => void;
  onMerge: (mode: 'merge' | 'request', personId: string) => void;
  onReview: (request: MergeRequest) => void;
  onOpenPerson: (personId: string) => void;
}

export function PersonCard({ personId, onBack, onMerge, onReview, onOpenPerson }: PersonCardProps) {
  const seeRestricted = can.seeRestricted.value;
  const reviewer = can.review.value;
  const writer = can.write.value;
  const detail = useLiveQuery<PersonDetail | null | 'loading'>(
    () => loadPersonDetail(personId, { withPay: seeRestricted }),
    [personId, seeRestricted],
    'loading',
  );
  const history = useLiveQuery(
    () => (reviewer ? mergeRequestsOf(personId) : []),
    [personId, reviewer],
    [],
  );
  const [editing, setEditing] = useState(false);

  if (detail === 'loading' || detail === undefined) {
    return (
      <section class="card people__card" aria-busy="true">
        <Spinner />
      </section>
    );
  }
  if (detail === null) {
    return (
      <section class="card people__card" data-testid="person-card-missing">
        <Button size="sm" variant="ghost" class="pcard__back" testId="person-back" onClick={onBack}>
          {t('people.back')}
        </Button>
        <EmptyState
          title={t('people.personMissingTitle')}
          message={t('people.personMissingBody')}
        />
      </section>
    );
  }

  const { person, homePath, assignments, hidden } = detail;
  const unsynced = person.version === 0 || person._dirty === 1;
  const area = areaChainText(homePath) || person.home_area_text || '';

  return (
    <section
      class="card people__card"
      data-testid="person-card"
      data-person-id={person.id}
      aria-labelledby="person-card-title"
    >
      <Button size="sm" variant="ghost" class="pcard__back" testId="person-back" onClick={onBack}>
        {t('people.back')}
      </Button>
      <div class="pcard__head">
        <h2 id="person-card-title">
          <NameBlock person={person} />
        </h2>
        <div class="pcard__actions">
          {unsynced && <Badge tone="gold">{t('people.unsynced')}</Badge>}
          {writer && (
            <Button
              size="sm"
              variant="primary"
              testId="person-edit"
              onClick={() => setEditing(true)}
            >
              {t('people.edit')}
            </Button>
          )}
          {reviewer ? (
            <Button size="sm" testId="person-merge" onClick={() => onMerge('merge', person.id)}>
              {t('people.mergeAction')}
            </Button>
          ) : (
            writer && (
              <Button
                size="sm"
                testId="person-request-merge"
                onClick={() => onMerge('request', person.id)}
              >
                {t('people.requestMergeAction')}
              </Button>
            )
          )}
        </div>
      </div>

      <dl class="kv">
        <dt>{t('people.fieldNameAr')}</dt>
        <dd>{person.name_ar || <span class="muted">{t('people.notSet')}</span>}</dd>
        <dt>{t('people.fieldNameLatin')}</dt>
        <dd dir="auto">{person.name_latin || <span class="muted">{t('people.notSet')}</span>}</dd>
        <dt>{t('people.fieldPhone')}</dt>
        <dd data-testid="person-phone">
          <PhoneText phone={person.phone_e164} />
        </dd>
        <dt>{t('people.fieldGender')}</dt>
        <dd>
          {person.gender ? (
            t(`enum.gender.${person.gender}`)
          ) : (
            <span class="muted">{t('people.notSet')}</span>
          )}
        </dd>
        <dt>{t('people.fieldBirthYear')}</dt>
        <dd>{person.birth_year ?? <span class="muted">{t('people.notSet')}</span>}</dd>
        <dt>{t('people.fieldHomeArea')}</dt>
        <dd>{area || <span class="muted">{t('people.notSet')}</span>}</dd>
        <dt>{t('people.fieldEducation')}</dt>
        <dd>{person.education_level || <span class="muted">{t('people.notSet')}</span>}</dd>
        <dt>{t('people.fieldGraduatedFrom')}</dt>
        <dd>{person.graduated_from || <span class="muted">{t('people.notSet')}</span>}</dd>
      </dl>

      <section class="pcard__section" aria-labelledby="person-assignments-title">
        <h3 id="person-assignments-title">{t('people.assignmentsTitle')}</h3>
        {assignments.length === 0 && hidden === 0 ? (
          <p class="muted">{t('people.assignmentsEmpty')}</p>
        ) : (
          <ul class="pcard__assignments" data-testid="person-assignments">
            {assignments.map(({ staff, project, pay, current }) => (
              <li
                key={staff.id}
                class={current ? 'pcard__assignment' : 'pcard__assignment pcard__assignment--ended'}
                data-testid="person-assignment"
              >
                <div class="pcard__assignment-main">
                  {project && (
                    <Link
                      class="pcard__project"
                      href={`/projects/${project.id}`}
                      testId="person-project-link"
                    >
                      {project.code && (
                        <span class="ltr mono" dir="ltr">
                          {project.code}
                        </span>
                      )}{' '}
                      <bdi>{pickName(project)}</bdi>
                    </Link>
                  )}
                  <span>
                    {t(`enum.staff_role.${staff.role}`)}
                    {project && (
                      <span class="muted"> · {t(`enum.project_type.${project.type}`)}</span>
                    )}
                  </span>
                  <span class="muted">{datesText(staff.start_date, staff.end_date)}</span>
                  {seeRestricted && (
                    <span class="pcard__pay" data-testid="person-salary">
                      {t('people.salary')}:{' '}
                      {pay ? (
                        <span dir="ltr" class="ltr">
                          {fmt.currency(pay.monthly_amount, pay.currency)}
                        </span>
                      ) : (
                        <span class="muted">{t('people.salaryNone')}</span>
                      )}
                    </span>
                  )}
                </div>
                <Badge tone={current ? 'active' : 'inactive'}>
                  {current ? t('people.assignmentCurrent') : t('people.assignmentEnded')}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {hidden > 0 && <p class="muted">{t('people.hiddenProjects', { count: hidden })}</p>}
      </section>

      {reviewer && (history?.length ?? 0) > 0 && (
        <section class="pcard__section" aria-labelledby="person-history-title">
          <h3 id="person-history-title">{t('people.mergeHistory')}</h3>
          <MergeRequestList
            requests={history ?? []}
            canReview={reviewer}
            onReview={onReview}
            onOpenPerson={(id) => id !== person.id && onOpenPerson(id)}
            testId="person-merge-history"
          />
        </section>
      )}

      <EditPersonDialog open={editing} person={person} onClose={() => setEditing(false)} />
    </section>
  );
}

/** Edit a person; Esc, the close button and the backdrop never discard typed changes. */
function EditPersonDialog({
  open,
  person,
  onClose,
}: {
  open: boolean;
  person: Row<'persons'>;
  onClose: () => void;
}) {
  const [state, setState] = useState<PersonFormState | null>(null);
  const [initial, setInitial] = useState<string>('');
  const [errors, setErrors] = useState<PersonFormErrors>({});
  const [busy, setBusy] = useState(false);
  const [countryNames, setCountryNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) {
      setState(null);
      return;
    }
    let alive = true;
    void (async () => {
      const [dial, countries] = await Promise.all([defaultDial(me.peek()), listCountries()]);
      if (!alive) return;
      const s = formStateOf(person, dial);
      setCountryNames(Object.fromEntries(countries.map((c) => [c.iso2, pickName(c)])));
      setState(s);
      setInitial(JSON.stringify(s));
      setErrors({});
    })();
    return () => {
      alive = false;
    };
  }, [open, person.id]);

  const dirty = state !== null && JSON.stringify(state) !== initial;
  const confirmClose = async (): Promise<boolean> =>
    !dirty ||
    confirm({
      title: t('people.discardTitle'),
      message: t('people.discardMessage'),
      confirmLabel: t('people.discardConfirm'),
      danger: true,
    });

  const save = async (): Promise<void> => {
    if (!state) return;
    const { draft, errors: found } = validatePersonForm(state);
    setErrors(found);
    if (!draft) {
      // Move to the first field that needs attention once the errors are rendered.
      setTimeout(() => {
        document
          .querySelector<HTMLElement>('[data-testid="person-edit-dialog"] [aria-invalid="true"]')
          ?.focus();
      }, 0);
      return;
    }
    setBusy(true);
    try {
      const changed = await updatePerson(person, draft);
      toast(
        changed.length > 0 ? t('people.saved') : t('people.noChanges'),
        changed.length > 0 ? 'success' : 'info',
      );
      onClose();
    } catch (error) {
      console.error('[people] update person', error);
      toast(t('people.saveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('people.editTitle', { name: primaryName(person) })}
      size="lg"
      testId="person-edit-dialog"
      onClose={onClose}
      confirmClose={confirmClose}
      footer={
        <>
          <Button
            testId="person-edit-cancel"
            onClick={() => void confirmClose().then((ok) => ok && onClose())}
          >
            {t('ui.cancel')}
          </Button>
          <Button
            variant="primary"
            testId="person-edit-save"
            busy={busy}
            disabled={!state}
            onClick={() => void save()}
          >
            {t('people.save')}
          </Button>
        </>
      }
    >
      {state ? (
        <PersonForm
          idBase="person-edit"
          state={state}
          errors={errors}
          countryNames={countryNames}
          onChange={setState}
        />
      ) : (
        <Spinner />
      )}
    </Modal>
  );
}
