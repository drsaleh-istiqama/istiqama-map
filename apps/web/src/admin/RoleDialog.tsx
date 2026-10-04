/**
 * "Assign a role": role → allowed scope type → country or branch (people-admin.md §6
 * `admin_set_role`). Only the scope types the role allows are offered; a single one is chosen
 * automatically. Esc / the close button never drop a started choice without asking.
 */
import { useMemo, useState } from 'preact/hooks';
import type { RoleName } from '../auth';
import { t } from '../i18n';
import { Button, Field, Modal, Select, toast } from '../ui';
import { refreshOwnContext, setRole } from './api';
import { adminErrorKey } from './errors';
import { branchLabel, countryName, roleLabel, scopeTypeLabel } from './labels';
import { roleNeedsMfa, scopesFor } from './roles';
import { errorText, FormError, useCloseGuard } from './shared';
import { ROLE_NAMES, type AdminUser, type ScopeType } from './types';
import { validateRole, type Errors, type RoleDraft, type RoleField } from './validate';

export interface ScopeCountry {
  id: string;
  name_ar: string;
  name_en: string | null;
  name_sw: string | null;
  active: boolean;
  deleted_at: string | null;
}

export interface ScopeBranch extends ScopeCountry {
  country_id: string;
}

export interface ScopeChoices {
  countries: readonly ScopeCountry[];
  branches: readonly ScopeBranch[];
}

/** Live countries / branches as select options, sorted by their label. */
export function scopeOptions(
  choices: ScopeChoices,
  scopeType: ScopeType | '',
): Array<{ value: string; label: string }> {
  if (scopeType === 'country') {
    return choices.countries
      .filter((c) => !c.deleted_at)
      .map((c) => ({
        value: c.id,
        label: c.active ? countryName(c) : t('admin.inactiveSuffix', { name: countryName(c) }),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  if (scopeType === 'branch') {
    const byId = new Map(choices.countries.map((c) => [c.id, c]));
    return choices.branches
      .filter((b) => !b.deleted_at)
      .map((b) => {
        const label = branchLabel(b, byId.get(b.country_id));
        return {
          value: b.id,
          label: b.active ? label : t('admin.inactiveSuffix', { name: label }),
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  return [];
}

/** Role + scope fields, also used by the "new account" dialog. */
export function RoleFields({
  draft,
  onChange,
  errors,
  choices,
  idBase,
  optional = false,
}: {
  draft: RoleDraft;
  onChange: (next: RoleDraft) => void;
  errors: Errors<RoleField>;
  choices: ScopeChoices;
  idBase: string;
  optional?: boolean;
}) {
  const allowed = scopesFor(draft.role);
  const options = useMemo(
    () => scopeOptions(choices, draft.scope_type),
    [choices, draft.scope_type],
  );

  const setRoleValue = (value: string): void => {
    const role = value as RoleName | '';
    const scopes = scopesFor(role);
    const scope_type: ScopeType | '' =
      scopes.length === 1
        ? (scopes[0] as ScopeType)
        : scopes.includes(draft.scope_type as ScopeType)
          ? draft.scope_type
          : '';
    onChange({ role, scope_type, scope_id: scope_type === draft.scope_type ? draft.scope_id : '' });
  };

  return (
    <>
      <Field
        label={t('admin.fieldRole')}
        htmlFor={`${idBase}-role`}
        required={!optional}
        error={errorText(errors.role)}
      >
        <Select
          testId={`${idBase}-role`}
          value={draft.role}
          placeholder={optional ? t('admin.noRoleYet') : t('admin.choose')}
          options={ROLE_NAMES.map((r) => ({ value: r, label: roleLabel(r) }))}
          onChange={setRoleValue}
        />
      </Field>
      {draft.role && roleNeedsMfa(draft.role) && (
        <p class="adm-note" data-testid={`${idBase}-mfa-note`}>
          {t('admin.mfaNote')}
        </p>
      )}
      {draft.role && (
        <Field
          label={t('admin.fieldScopeType')}
          htmlFor={`${idBase}-scope-type`}
          required
          error={errorText(errors.scope_type)}
        >
          <Select
            testId={`${idBase}-scope-type`}
            value={draft.scope_type}
            placeholder={allowed.length > 1 ? t('admin.choose') : undefined}
            options={allowed.map((s) => ({ value: s, label: scopeTypeLabel(s) }))}
            onChange={(value) =>
              onChange({ ...draft, scope_type: value as ScopeType | '', scope_id: '' })
            }
          />
        </Field>
      )}
      {(draft.scope_type === 'country' || draft.scope_type === 'branch') && (
        <Field
          label={draft.scope_type === 'country' ? t('admin.fieldCountry') : t('admin.fieldBranch')}
          htmlFor={`${idBase}-scope`}
          required
          error={errorText(errors.scope_id)}
          hint={options.length === 0 ? t('admin.noScopeChoices') : undefined}
        >
          <Select
            testId={`${idBase}-scope`}
            value={draft.scope_id}
            placeholder={t('admin.choose')}
            options={options}
            onChange={(value) => onChange({ ...draft, scope_id: value })}
          />
        </Field>
      )}
    </>
  );
}

const EMPTY: RoleDraft = { role: '', scope_type: '', scope_id: '' };

export function RoleDialog({
  user,
  choices,
  myUserId,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  choices: ScopeChoices;
  myUserId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<RoleDraft>(EMPTY);
  const [errors, setErrors] = useState<Errors<RoleField>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const dirty = draft.role !== '' || draft.scope_id !== '';
  const guard = useCloseGuard(dirty && !busy);

  const save = async (): Promise<void> => {
    if (busy) return;
    const checked = validateRole(draft, user);
    setErrors(checked.errors);
    setFailure(null);
    if (!checked.ok) return;
    setBusy(true);
    try {
      const result = await setRole(
        user.id,
        checked.value.role,
        checked.value.scope_type,
        checked.value.scope_id,
      );
      toast(result.created ? t('admin.roleAssigned') : t('admin.roleAlreadyThere'), 'success');
      if (user.id === myUserId) refreshOwnContext();
      onSaved();
    } catch (e) {
      setFailure(t(adminErrorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={t('admin.assignRoleTitle', { name: user.full_name || user.email || '' })}
      onClose={onClose}
      confirmClose={guard}
      testId="admin-role-dialog"
      footer={
        <>
          <Button
            testId="admin-role-cancel"
            onClick={() => void guard().then((ok) => ok && onClose())}
          >
            {t('admin.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            testId="admin-role-save"
            onClick={() => void save()}
          >
            {t('admin.assign')}
          </Button>
        </>
      }
    >
      <form
        class="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        noValidate
      >
        <RoleFields
          draft={draft}
          onChange={setDraft}
          errors={errors}
          choices={choices}
          idBase="admin-role"
        />
        <FormError message={failure} testId="admin-role-error" />
      </form>
    </Modal>
  );
}
