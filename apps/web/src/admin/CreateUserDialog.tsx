/**
 * "New account" (head office): accounts are provisioned by administrators — there is no
 * self sign-up. The `admin` Edge Function creates the Auth user (e-mail and/or phone, both
 * confirmed), the profile and, optionally, the first role. The person then signs in with a
 * code sent to that e-mail or phone; managers and administrators enrol their second factor
 * on first sign-in.
 */
import { useState } from 'preact/hooks';
import { toE164 } from '../auth';
import { t } from '../i18n';
import { Button, Field, Modal, Select, toast } from '../ui';
import { createUser } from './api';
import { adminErrorKey } from './errors';
import { RoleFields, type ScopeChoices } from './RoleDialog';
import { errorText, FormError, useCloseGuard } from './shared';
import type { AdminUser } from './types';
import {
  validateNewUser,
  type Errors,
  type NewUserDraft,
  type NewUserField,
  type RoleDraft,
} from './validate';

const EMPTY: NewUserDraft = {
  full_name: '',
  email: '',
  phone: '',
  preferred_language: 'ar',
  role: '',
  scope_type: '',
  scope_id: '',
};

/**
 * "+255 712 345 678" / "00255712345678" → "+255712345678". A national number is left as typed
 * (the country cannot be guessed): validation then asks for the international form.
 */
function phoneForCheck(raw: string): string {
  const trimmed = raw.trim();
  if (!/^(\+|00)/.test(trimmed)) return trimmed;
  return toE164(trimmed, '') ?? trimmed;
}

export function CreateUserDialog({
  users,
  choices,
  onClose,
  onCreated,
}: {
  users: readonly AdminUser[];
  choices: ScopeChoices;
  onClose: () => void;
  onCreated: (userId: string) => void;
}) {
  const [draft, setDraft] = useState<NewUserDraft>(EMPTY);
  const [errors, setErrors] = useState<Errors<NewUserField>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const dirty =
    draft.full_name !== '' || draft.email !== '' || draft.phone !== '' || draft.role !== '';
  const guard = useCloseGuard(dirty && !busy);
  const set = (patch: Partial<NewUserDraft>): void => setDraft((d) => ({ ...d, ...patch }));

  const save = async (): Promise<void> => {
    if (busy) return;
    const checked = validateNewUser({ ...draft, phone: phoneForCheck(draft.phone) }, users);
    setErrors(checked.errors);
    setFailure(null);
    if (!checked.ok) return;
    setBusy(true);
    try {
      const result = await createUser(checked.value);
      if (result.role_error) {
        toast(t('admin.userCreatedRoleFailed'), 'error');
      } else {
        toast(t('admin.userCreated'), 'success');
      }
      onCreated(result.user_id);
    } catch (e) {
      setFailure(t(adminErrorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  const roleDraft: RoleDraft = {
    role: draft.role,
    scope_type: draft.scope_type,
    scope_id: draft.scope_id,
  };

  return (
    <Modal
      open
      size="lg"
      title={t('admin.newUserTitle')}
      onClose={onClose}
      confirmClose={guard}
      testId="admin-create-dialog"
      footer={
        <>
          <Button
            testId="admin-create-cancel"
            onClick={() => void guard().then((ok) => ok && onClose())}
          >
            {t('admin.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            testId="admin-create-save"
            onClick={() => void save()}
          >
            {t('admin.createUser')}
          </Button>
        </>
      }
    >
      <form
        class="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p class="adm-note">{t('admin.newUserIntro')}</p>
        <Field
          label={t('admin.fieldFullName')}
          htmlFor="admin-create-name"
          required
          error={errorText(errors.full_name)}
        >
          <input
            class="control"
            data-testid="admin-create-name"
            value={draft.full_name}
            maxLength={120}
            autocomplete="off"
            onInput={(e) => set({ full_name: e.currentTarget.value })}
          />
        </Field>
        <Field
          label={t('admin.fieldEmail')}
          htmlFor="admin-create-email"
          error={errorText(errors.email)}
          hint={t('admin.emailOrPhoneHint')}
        >
          <input
            class="control"
            type="email"
            dir="ltr"
            inputMode="email"
            autocomplete="off"
            data-testid="admin-create-email"
            value={draft.email}
            maxLength={254}
            onInput={(e) => set({ email: e.currentTarget.value })}
          />
        </Field>
        <Field
          label={t('admin.fieldPhone')}
          htmlFor="admin-create-phone"
          error={errorText(errors.phone)}
          hint={t('admin.phoneHint')}
        >
          <input
            class="control"
            type="tel"
            dir="ltr"
            inputMode="tel"
            autocomplete="off"
            data-testid="admin-create-phone"
            value={draft.phone}
            maxLength={20}
            onInput={(e) => set({ phone: e.currentTarget.value })}
            onBlur={(e) => set({ phone: phoneForCheck(e.currentTarget.value) })}
          />
        </Field>
        <Field label={t('admin.fieldLanguage')} htmlFor="admin-create-language">
          <Select
            testId="admin-create-language"
            value={draft.preferred_language}
            options={[
              { value: 'ar', label: t('admin.lang_ar') },
              { value: 'sw', label: t('admin.lang_sw') },
              { value: 'en', label: t('admin.lang_en') },
            ]}
            onChange={(value) =>
              set({ preferred_language: value as NewUserDraft['preferred_language'] })
            }
          />
        </Field>
        <fieldset class="adm-fieldset">
          <legend>{t('admin.firstRole')}</legend>
          <RoleFields
            draft={roleDraft}
            onChange={(next) =>
              set({ role: next.role, scope_type: next.scope_type, scope_id: next.scope_id })
            }
            errors={errors}
            choices={choices}
            idBase="admin-create"
            optional
          />
        </fieldset>
        <FormError message={failure} testId="admin-create-error" />
      </form>
    </Modal>
  );
}
