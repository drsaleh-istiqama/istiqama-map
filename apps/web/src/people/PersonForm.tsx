/**
 * Fields of a person (brief §2.4): Arabic name (required), Latin name, phone in E.164 with
 * the calling code of the user's country, gender, birth year, home area, education level,
 * graduated from. Used by the picker's "new person" form and by "edit person".
 *
 * Controlled: the parent keeps a `PersonFormState`, validates it with `validatePersonForm`
 * on submit and shows the returned errors next to their fields (brief §7.6).
 */
import { DIAL_COUNTRIES } from '../auth';
import { GENDERS, type Row } from '../db';
import { t } from '../i18n';
import { Field, Select } from '../ui';
import { AreaPicker } from './AreaPicker';
import type { PersonDraft } from './persons';
import { cleanPhoneInput, isoForDial, splitE164, toPersonE164 } from './phone';

export interface PersonFormState {
  name_ar: string;
  name_latin: string;
  /** Calling code without "+", '' = none selected (international number typed). */
  dial: string;
  /** What the user typed in the number box. */
  phone: string;
  gender: '' | 'male' | 'female';
  birth_year: string;
  home_admin_area_id: string | null;
  education_level: string;
  graduated_from: string;
}

export type PersonFormErrors = Partial<Record<'name_ar' | 'phone' | 'birth_year', string>>;

export const MIN_BIRTH_YEAR = 1900;
export const maxBirthYear = (): number => new Date().getFullYear();

export function emptyFormState(
  dial: string | null,
  seed: Partial<PersonFormState> = {},
): PersonFormState {
  return {
    name_ar: '',
    name_latin: '',
    dial: dial ?? '',
    phone: '',
    gender: '',
    birth_year: '',
    home_admin_area_id: null,
    education_level: '',
    graduated_from: '',
    ...seed,
  };
}

/** Form state of a stored person (edit). */
export function formStateOf(person: Row<'persons'>, fallbackDial: string | null): PersonFormState {
  const split = splitE164(person.phone_e164);
  return {
    name_ar: person.name_ar ?? '',
    name_latin: person.name_latin ?? '',
    dial: split.dial ?? (person.phone_e164 ? '' : (fallbackDial ?? '')),
    phone: split.dial ? split.national : (person.phone_e164 ?? ''),
    gender: person.gender ?? '',
    birth_year: person.birth_year ? String(person.birth_year) : '',
    home_admin_area_id: person.home_admin_area_id,
    education_level: person.education_level ?? '',
    graduated_from: person.graduated_from ?? '',
  };
}

/** E.164 of the phone fields: undefined = empty box, null = not a valid number. */
export function formPhone(
  state: Pick<PersonFormState, 'dial' | 'phone'>,
): string | null | undefined {
  const typed = cleanPhoneInput(state.phone);
  if (typed === '' || typed === '+') return undefined;
  return toPersonE164(state.phone, state.dial || null);
}

export function validatePersonForm(state: PersonFormState): {
  draft: PersonDraft | null;
  errors: PersonFormErrors;
} {
  const errors: PersonFormErrors = {};
  const nameAr = state.name_ar.replace(/\s+/g, ' ').trim();
  if (nameAr === '') errors.name_ar = t('people.nameArRequired');

  const phone = formPhone(state);
  if (phone === null) {
    const typed = cleanPhoneInput(state.phone);
    errors.phone =
      !state.dial && !typed.startsWith('+') && !typed.startsWith('00')
        ? t('people.phoneNeedsPrefix')
        : t('people.phoneInvalid');
  }

  let birthYear: number | undefined;
  const yearText = cleanPhoneInput(state.birth_year); // also maps Arabic-Indic digits
  if (yearText !== '') {
    birthYear = Number(yearText);
    if (!Number.isInteger(birthYear) || birthYear < MIN_BIRTH_YEAR || birthYear > maxBirthYear()) {
      errors.birth_year = t('people.birthYearInvalid', {
        min: String(MIN_BIRTH_YEAR),
        max: String(maxBirthYear()),
      });
    }
  }

  if (Object.keys(errors).length > 0) return { draft: null, errors };
  const draft: PersonDraft = { name_ar: nameAr };
  if (state.name_latin.trim()) draft.name_latin = state.name_latin.trim();
  if (phone) draft.phone_e164 = phone;
  if (state.gender) draft.gender = state.gender;
  if (birthYear !== undefined) draft.birth_year = birthYear;
  if (state.home_admin_area_id) draft.home_admin_area_id = state.home_admin_area_id;
  if (state.education_level.trim()) draft.education_level = state.education_level.trim();
  if (state.graduated_from.trim()) draft.graduated_from = state.graduated_from.trim();
  return { draft, errors };
}

export interface PersonFormProps {
  state: PersonFormState;
  onChange: (next: PersonFormState) => void;
  errors: PersonFormErrors;
  /** Prefix of element ids and test ids, e.g. `person-new`. */
  idBase: string;
  /** Country names for the calling-code select, keyed by ISO2. */
  countryNames?: Record<string, string>;
}

export function PersonForm({
  state,
  onChange,
  errors,
  idBase,
  countryNames = {},
}: PersonFormProps) {
  const set = <K extends keyof PersonFormState>(key: K, value: PersonFormState[K]): void =>
    onChange({ ...state, [key]: value });
  const country = DIAL_COUNTRIES.find((c) => c.dial === state.dial);
  const example = country
    ? '712345678'.slice(0, country.nationalLength).replace(/(\d{3})(?=\d)/g, '$1 ')
    : '';

  return (
    <div class="pp-form" data-testid={`${idBase}-form`}>
      <Field
        label={t('people.fieldNameAr')}
        htmlFor={`${idBase}-name-ar`}
        required
        error={errors.name_ar}
      >
        <input
          class="control"
          type="text"
          lang="ar"
          dir="rtl"
          autocomplete="off"
          data-testid={`${idBase}-name-ar`}
          value={state.name_ar}
          onInput={(e) => set('name_ar', e.currentTarget.value)}
        />
      </Field>
      <Field label={t('people.fieldNameLatin')} htmlFor={`${idBase}-name-latin`}>
        <input
          class="control"
          type="text"
          dir="ltr"
          autocomplete="off"
          data-testid={`${idBase}-name-latin`}
          value={state.name_latin}
          onInput={(e) => set('name_latin', e.currentTarget.value)}
        />
      </Field>

      <div class={['field', errors.phone && 'field--invalid'].filter(Boolean).join(' ')}>
        <span class="field__label" id={`${idBase}-phone-label`}>
          {t('people.fieldPhone')}
        </span>
        <div class="pp-phone" dir="ltr">
          <Select
            class="pp-phone__dial"
            testId={`${idBase}-dial`}
            aria-label={t('people.phonePrefix')}
            value={state.dial}
            options={[
              ...DIAL_COUNTRIES.map((c) => ({
                value: c.dial,
                label: `+${c.dial} ${countryNames[c.iso2] ?? c.iso2}`,
              })),
              { value: '', label: t('people.phonePrefixOther') },
            ]}
            onChange={(dial) => set('dial', dial)}
          />
          <input
            id={`${idBase}-phone`}
            class="control pp-phone__number"
            type="tel"
            inputMode="tel"
            dir="ltr"
            autocomplete="off"
            aria-labelledby={`${idBase}-phone-label`}
            aria-describedby={`${idBase}-phone-hint${errors.phone ? ` ${idBase}-phone-error` : ''}`}
            aria-invalid={errors.phone ? 'true' : undefined}
            data-testid={`${idBase}-phone`}
            placeholder={example}
            value={state.phone}
            onInput={(e) => set('phone', e.currentTarget.value)}
          />
        </div>
        <p class="field__hint" id={`${idBase}-phone-hint`}>
          {example ? t('people.phoneHint', { example }) : t('people.phoneHintIntl')}
        </p>
        {errors.phone && (
          <p class="field__error" id={`${idBase}-phone-error`} role="alert">
            {errors.phone}
          </p>
        )}
      </div>

      <div class="pp-form__row">
        <Field label={t('people.fieldGender')} htmlFor={`${idBase}-gender`}>
          <Select
            testId={`${idBase}-gender`}
            value={state.gender}
            placeholder={t('people.choose')}
            options={GENDERS.map((g) => ({ value: g, label: t(`enum.gender.${g}`) }))}
            onChange={(g) => set('gender', g as PersonFormState['gender'])}
          />
        </Field>
        <Field
          label={t('people.fieldBirthYear')}
          htmlFor={`${idBase}-birth-year`}
          error={errors.birth_year}
        >
          <input
            class="control"
            type="text"
            inputMode="numeric"
            dir="ltr"
            maxLength={4}
            autocomplete="off"
            data-testid={`${idBase}-birth-year`}
            placeholder={String(maxBirthYear() - 30)}
            value={state.birth_year}
            onInput={(e) => set('birth_year', e.currentTarget.value)}
          />
        </Field>
      </div>

      <AreaPicker
        idBase={`${idBase}-area`}
        value={state.home_admin_area_id}
        defaultCountryIso={isoForDial(state.dial)}
        onChange={(id) => set('home_admin_area_id', id)}
      />

      <Field label={t('people.fieldEducation')} htmlFor={`${idBase}-education`}>
        <input
          class="control"
          type="text"
          autocomplete="off"
          data-testid={`${idBase}-education`}
          value={state.education_level}
          onInput={(e) => set('education_level', e.currentTarget.value)}
        />
      </Field>
      <Field label={t('people.fieldGraduatedFrom')} htmlFor={`${idBase}-graduated`}>
        <input
          class="control"
          type="text"
          autocomplete="off"
          data-testid={`${idBase}-graduated`}
          value={state.graduated_from}
          onInput={(e) => set('graduated_from', e.currentTarget.value)}
        />
      </Field>
    </div>
  );
}
