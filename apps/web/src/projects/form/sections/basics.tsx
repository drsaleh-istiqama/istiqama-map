/** Steps 1–2 of the form (brief §7.1): project type (radio cards), then the name. */
import { t } from '../../../i18n';
import { PROJECT_TYPES } from '../../../db';
import { TypeIcon, typeLabel } from '../../labels';
import { useForm } from '../context';
import { F, TextInput } from '../controls';
import { fieldId } from '../validate';

export function TypeSection() {
  const { draft, api, errors } = useForm();
  const value = draft.working.project.type as string | null;
  const error = errors.type;
  const errorId = `${fieldId('type')}-error`;
  return (
    <fieldset
      class={error ? 'pf-step pf-types field--invalid' : 'pf-step pf-types'}
      id={fieldId('type')}
      aria-describedby={error ? errorId : undefined}
      aria-invalid={error ? 'true' : undefined}
    >
      <legend class="field__label">
        {t('form.type')}
        <span class="field__required" aria-hidden="true">
          *
        </span>
        <span class="sr-only"> ({t('ui.required')})</span>
      </legend>
      <div class="pf-types__grid">
        {PROJECT_TYPES.map((code) => (
          <label key={code} class={value === code ? 'pf-card pf-card--on' : 'pf-card'}>
            <input
              type="radio"
              name="pf-type"
              value={code}
              class="pf-card__input"
              checked={value === code}
              required
              data-testid={`form-type-${code}`}
              onChange={() => {
                api.setProject({ type: code });
                api.clearError('type');
              }}
            />
            <TypeIcon type={code} size={28} />
            <span class="pf-card__label">{typeLabel(code)}</span>
          </label>
        ))}
      </div>
      {error && (
        <p class="field__error" id={errorId} role="alert">
          {t(error)}
        </p>
      )}
    </fieldset>
  );
}

export function NameSection() {
  const { draft, api } = useForm();
  const p = draft.working.project;
  return (
    <div class="pf-step pf-names">
      <F k="name_ar" label={t('form.nameAr')} required hint={t('form.nameArHint')}>
        <TextInput
          value={p.name_ar}
          dir="auto"
          testId="form-name"
          onValue={(v) => {
            api.setProject({ name_ar: v });
            api.clearError('name_ar');
          }}
        />
      </F>
      <F k="name_latin" label={t('form.nameLatin')} hint={t('form.nameLatinHint')}>
        <TextInput
          value={p.name_latin}
          dir="ltr"
          testId="form-name-latin"
          onValue={(v) => api.setProject({ name_latin: v === '' ? null : v })}
        />
      </F>
    </div>
  );
}
