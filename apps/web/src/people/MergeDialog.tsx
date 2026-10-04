/**
 * Manual merge of two person records (brief §2.4, people-admin.md §4).
 *
 *   mode 'merge'   reviewer: choose the duplicate (source) and the record that stays (target),
 *                  compare them side by side, give a reason → `merge_persons` (undoable)
 *   mode 'request' other roles: the same form → `request_person_merge` (a reviewer decides)
 *   mode 'decide'  reviewer: a pending request side by side → approve / reject
 *
 * Every successful call is followed by `syncNow()` so the device pulls the re-pointed staff
 * rows, the removed duplicate and the completed target.
 */
import { useEffect, useState } from 'preact/hooks';
import { findLocalPersonCandidates, type Row } from '../db';
import { fmt, t } from '../i18n';
import { Button, confirm, Field, Modal, toast } from '../ui';
import { syncNow } from '../sync';
import { areaChainText } from './AreaPicker';
import { fullName, NameBlock, PhoneText, primaryName } from './display';
import { PersonSearch } from './PersonSearch';
import { areaPath, loadPerson, rememberNames, summarisePeople, type MergeRequest } from './queries';
import {
  isOnline,
  mergePersons,
  requestPersonMerge,
  resolvePersonMergeRequest,
  rpcErrorKey,
  type MergeResult,
} from './rpc';

type Person = Row<'persons'>;
export type MergeMode = 'merge' | 'request' | 'decide';

export interface MergeDialogProps {
  open: boolean;
  mode: MergeMode;
  initialSourceId?: string | null;
  initialTargetId?: string | null;
  /** The pending request being decided (mode 'decide'). */
  request?: MergeRequest | null;
  onClose: () => void;
  /** After a successful call; `targetId` = the person that stays. */
  onDone: (result: { targetId: string | null }) => void;
}

/** Target fields the server fills from the source when they are blank (never overwritten). */
const FILLED_FIELDS = [
  'name_latin',
  'phone_e164',
  'gender',
  'birth_year',
  'home_admin_area_id',
  'education_level',
  'graduated_from',
] as const;

interface SideInfo {
  area: string;
  assignments: number;
}

const blank = (v: unknown): boolean => v === null || v === undefined || v === '';

export function MergeDialog(props: MergeDialogProps) {
  return props.open ? <MergeDialogBody {...props} /> : null;
}

function MergeDialogBody({
  mode,
  initialSourceId,
  initialTargetId,
  request,
  onClose,
  onDone,
}: MergeDialogProps) {
  const [source, setSource] = useState<Person | null>(null);
  const [target, setTarget] = useState<Person | null>(null);
  const [info, setInfo] = useState<Record<string, SideInfo>>({});
  const [suggestions, setSuggestions] = useState<Person[]>([]);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'submit' | 'approve' | 'reject'>(null);

  const sourceId =
    mode === 'decide' ? (request?.source_person_id ?? null) : (initialSourceId ?? null);
  const targetId =
    mode === 'decide' ? (request?.target_person_id ?? null) : (initialTargetId ?? null);

  useEffect(() => {
    void (async () => {
      if (sourceId) setSource((await loadPerson(sourceId)) ?? null);
      if (targetId) setTarget((await loadPerson(targetId)) ?? null);
    })();
  }, [sourceId, targetId]);

  // Home area and number of assignments of both sides (comparison table).
  useEffect(() => {
    const people = [source, target].filter((p): p is Person => !!p);
    void (async () => {
      const summary = await summarisePeople(people);
      const next: Record<string, SideInfo> = {};
      for (const p of people) {
        next[p.id] = {
          area: areaChainText(await areaPath(p.home_admin_area_id)),
          assignments: summary.get(p.id)?.projects ?? 0,
        };
      }
      setInfo(next);
    })();
  }, [source?.id, target?.id, source?.home_admin_area_id, target?.home_admin_area_id]);

  // Possible duplicates of the source, to choose the target quickly.
  useEffect(() => {
    if (mode === 'decide' || !source || target) {
      setSuggestions([]);
      return;
    }
    void (async () => {
      const found = await findLocalPersonCandidates({
        name: source.name_ar ?? source.name_latin ?? '',
        phone: source.phone_e164 ?? undefined,
      });
      const others = found.filter((c) => c.id !== source.id).slice(0, 5);
      const rows = await Promise.all(others.map((c) => loadPerson(c.id)));
      setSuggestions(rows.filter((p): p is Person => !!p));
    })();
  }, [mode, source?.id, target?.id]);

  const dirty = mode === 'decide' ? note.trim() !== '' : reason.trim() !== '';
  const confirmClose = async (): Promise<boolean> =>
    !dirty ||
    confirm({
      title: t('people.discardTitle'),
      message: t('people.discardMessage'),
      confirmLabel: t('people.discardConfirm'),
      danger: true,
    });

  /** Common checks before any server call; returns an error text or null. */
  const precheck = (): string | null => {
    if (!source || !target) return t('people.chooseBoth');
    if (source.id === target.id) return t('people.samePersonsError');
    if (!isOnline()) return t('people.offlineError');
    for (const p of [source, target]) {
      if (p.version === 0) return t('people.unsyncedError', { name: primaryName(p) });
    }
    return null;
  };

  /** Local edits of either person go up first, so the server merges current data. */
  const pushFirst = async (): Promise<void> => {
    if (source?._dirty || target?._dirty) await syncNow();
  };

  const finish = (targetIdAfter: string | null): void => {
    void syncNow().catch(() => undefined);
    onDone({ targetId: targetIdAfter });
  };

  const submit = async (): Promise<void> => {
    setError(null);
    const problem = precheck();
    const why = reason.trim();
    setReasonError(why.length < 3 ? t('people.reasonRequired') : null);
    if (problem) {
      setError(problem);
      return;
    }
    if (why.length < 3) return;
    if (
      mode === 'merge' &&
      !(await confirm({
        title: t('people.confirmMergeTitle'),
        message: t('people.confirmMergeMessage', {
          source: fullName(source),
          target: fullName(target),
        }),
        confirmLabel: t('people.mergeSubmit'),
        danger: true,
      }))
    )
      return;
    setBusy('submit');
    rememberNames([source!, target!]);
    try {
      await pushFirst();
      if (mode === 'merge') {
        const res = await mergePersons(source!.id, target!.id, why);
        toast(t('people.merged', { moved: res.moved_staff + res.collapsed_staff }), 'success');
        finish(res.target_id);
      } else {
        const res = await requestPersonMerge(source!.id, target!.id, why);
        toast(res.created ? t('people.requested') : t('people.requestExists'), 'success');
        finish(null);
      }
    } catch (e) {
      setError(t(rpcErrorKey(e)));
    } finally {
      setBusy(null);
    }
  };

  const decide = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (!request) return;
    setError(null);
    const problem = precheck();
    if (problem) {
      setError(problem);
      return;
    }
    if (
      decision === 'approve' &&
      !(await confirm({
        title: t('people.confirmMergeTitle'),
        message: t('people.confirmMergeMessage', {
          source: fullName(source),
          target: fullName(target),
        }),
        confirmLabel: t('people.approve'),
        danger: true,
      }))
    )
      return;
    setBusy(decision);
    rememberNames([source!, target!]);
    try {
      await pushFirst();
      const res = await resolvePersonMergeRequest(request.id, decision, note.trim() || null);
      if (res.state === 'merged') {
        const merged = res as MergeResult;
        toast(
          t('people.merged', { moved: merged.moved_staff + merged.collapsed_staff }),
          'success',
        );
        finish(merged.target_id);
      } else {
        toast(t('people.rejectedToast'), 'success');
        finish(null);
      }
    } catch (e) {
      setError(t(rpcErrorKey(e)));
    } finally {
      setBusy(null);
    }
  };

  const title =
    mode === 'merge'
      ? t('people.mergeTitle')
      : mode === 'request'
        ? t('people.requestTitle')
        : t('people.decideTitle');
  const offline = !isOnline();

  const footer =
    mode === 'decide' ? (
      <>
        <Button
          testId="merge-cancel"
          onClick={() => void confirmClose().then((ok) => ok && onClose())}
        >
          {t('people.close')}
        </Button>
        <Button
          variant="danger"
          testId="merge-reject"
          busy={busy === 'reject'}
          disabled={!!busy || offline}
          onClick={() => void decide('reject')}
        >
          {t('people.reject')}
        </Button>
        <Button
          variant="primary"
          testId="merge-approve"
          busy={busy === 'approve'}
          disabled={!!busy || offline}
          onClick={() => void decide('approve')}
        >
          {t('people.approve')}
        </Button>
      </>
    ) : (
      <>
        <Button
          testId="merge-cancel"
          onClick={() => void confirmClose().then((ok) => ok && onClose())}
        >
          {t('ui.cancel')}
        </Button>
        <Button
          variant={mode === 'merge' ? 'danger' : 'primary'}
          testId="merge-submit"
          busy={busy === 'submit'}
          disabled={!!busy || offline}
          onClick={() => void submit()}
        >
          {mode === 'merge' ? t('people.mergeSubmit') : t('people.requestSubmit')}
        </Button>
      </>
    );

  return (
    <Modal
      open
      title={title}
      size="lg"
      testId="merge-dialog"
      onClose={onClose}
      confirmClose={confirmClose}
      footer={footer}
    >
      <p class="merge__intro">
        {mode === 'request' ? t('people.requestIntro') : t('people.mergeIntro')}
      </p>
      {offline && (
        <p class="merge__error" role="alert">
          {t('people.offlineError')}
        </p>
      )}

      <div class="merge__sides">
        <PersonSearch
          label={t('people.mergeSource')}
          testId="merge-source"
          value={source}
          onChange={setSource}
          excludeId={target?.id}
          disabled={mode === 'decide'}
        />
        {mode !== 'decide' && (
          <Button
            size="sm"
            testId="merge-swap"
            disabled={!source && !target}
            onClick={() => {
              setSource(target);
              setTarget(source);
            }}
          >
            {t('people.swap')}
          </Button>
        )}
        <PersonSearch
          label={t('people.mergeTarget')}
          testId="merge-target"
          value={target}
          onChange={setTarget}
          excludeId={source?.id}
          disabled={mode === 'decide'}
        />
      </div>

      {suggestions.length > 0 && (
        <section class="pcard__section" aria-labelledby="merge-suggestions-title">
          <h3 id="merge-suggestions-title">{t('people.suggestions')}</h3>
          <ul class="merge__suggestions">
            {suggestions.map((p) => (
              <li key={p.id} class="merge__suggestion">
                <NameBlock person={p} />
                <Button
                  size="sm"
                  testId="merge-suggestion"
                  data-person-id={p.id}
                  onClick={() => setTarget(p)}
                >
                  {t('people.useAsTarget')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {source && target && <Comparison source={source} target={target} info={info} />}

      {mode === 'decide' && request?.reason && (
        <p data-testid="merge-request-reason">
          <strong>{t('people.requestReason')}</strong> {request.reason}
        </p>
      )}

      {mode === 'decide' ? (
        <Field label={t('people.decisionNote')} htmlFor="merge-note">
          <textarea
            class="control"
            rows={2}
            data-testid="merge-note"
            value={note}
            onInput={(e) => setNote(e.currentTarget.value)}
          />
        </Field>
      ) : (
        <Field
          label={t('people.reason')}
          htmlFor="merge-reason"
          required
          error={reasonError}
          hint={t('people.reasonHint')}
        >
          <textarea
            class="control"
            rows={2}
            data-testid="merge-reason"
            value={reason}
            onInput={(e) => setReason(e.currentTarget.value)}
          />
        </Field>
      )}

      {error && (
        <p class="merge__error" role="alert" data-testid="merge-error">
          {error}
        </p>
      )}
    </Modal>
  );
}

function Comparison({
  source,
  target,
  info,
}: {
  source: Person;
  target: Person;
  info: Record<string, SideInfo>;
}) {
  const text = (p: Person, field: (typeof FILLED_FIELDS)[number] | 'name_ar'): string => {
    const v = p[field];
    if (blank(v)) return '';
    if (field === 'gender') return t(`enum.gender.${String(v)}`);
    if (field === 'home_admin_area_id') return info[p.id]?.area ?? '';
    return String(v);
  };
  const rows: Array<{
    key: string;
    label: string;
    field?: (typeof FILLED_FIELDS)[number] | 'name_ar';
  }> = [
    { key: 'name_ar', label: t('people.fieldNameAr'), field: 'name_ar' },
    { key: 'name_latin', label: t('people.fieldNameLatin'), field: 'name_latin' },
    { key: 'phone_e164', label: t('people.fieldPhone'), field: 'phone_e164' },
    { key: 'gender', label: t('people.fieldGender'), field: 'gender' },
    { key: 'birth_year', label: t('people.fieldBirthYear'), field: 'birth_year' },
    { key: 'home', label: t('people.fieldHomeArea'), field: 'home_admin_area_id' },
    { key: 'education_level', label: t('people.fieldEducation'), field: 'education_level' },
    { key: 'graduated_from', label: t('people.fieldGraduatedFrom'), field: 'graduated_from' },
  ];
  return (
    <table class="merge__compare" data-testid="merge-compare">
      <caption class="sr-only">{t('people.compareTitle')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('people.compareField')}</th>
          <th scope="col">{t('people.mergeSource')}</th>
          <th scope="col">{t('people.mergeTarget')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const s = row.field ? text(source, row.field) : '';
          const tg = row.field ? text(target, row.field) : '';
          const fills =
            row.field !== undefined &&
            row.field !== 'name_ar' &&
            (FILLED_FIELDS as readonly string[]).includes(row.field) &&
            blank(target[row.field]) &&
            !blank(source[row.field]);
          const isPhone = row.field === 'phone_e164';
          return (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td>
                {isPhone ? (
                  <PhoneText phone={s || null} />
                ) : (
                  s || <span class="muted">{t('people.notSet')}</span>
                )}
              </td>
              <td>
                {fills ? (
                  <>
                    {isPhone ? <PhoneText phone={s} /> : s}
                    <span class="merge__fill">{t('people.willFill')}</span>
                  </>
                ) : isPhone ? (
                  <PhoneText phone={tg || null} />
                ) : (
                  tg || <span class="muted">{t('people.notSet')}</span>
                )}
              </td>
            </tr>
          );
        })}
        <tr>
          <th scope="row">{t('people.assignmentsCount')}</th>
          <td>{fmt.number(info[source.id]?.assignments ?? 0)}</td>
          <td>{fmt.number(info[target.id]?.assignments ?? 0)}</td>
        </tr>
      </tbody>
    </table>
  );
}
