/**
 * Small controls of the form. Each one forwards `id`, `required`, `aria-describedby` and
 * `aria-invalid` to the native element, so `<Field>` can wire label, hint and inline error.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../i18n';
import { Field, Select, type SelectOption } from '../../ui';
import { enumLabel } from '../labels';
import { useForm } from './context';
import { fieldId } from './validate';

interface A11yProps {
  id?: string;
  required?: boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: 'true' | 'false' | boolean;
}

/** `<Field>` bound to a form key: id from the key, error from the form's error map. */
export function F({
  k,
  label,
  required,
  hint,
  children,
  class: extra,
}: {
  k: string;
  label: string;
  required?: boolean;
  hint?: string;
  class?: string;
  children: ComponentChildren;
}) {
  const { errors } = useForm();
  const error = errors[k];
  return (
    <Field
      label={label}
      htmlFor={fieldId(k)}
      required={required}
      hint={hint}
      error={error ? t(error) : null}
      class={extra}
    >
      {children}
    </Field>
  );
}

export function TextInput({
  value,
  onValue,
  testId,
  maxLength = 200,
  dir,
  placeholder,
  autoComplete = 'off',
  ...a11y
}: A11yProps & {
  value: string | null | undefined;
  onValue: (v: string) => void;
  testId?: string;
  maxLength?: number;
  dir?: 'ltr' | 'rtl' | 'auto';
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <input
      {...a11y}
      type="text"
      class="control"
      value={value ?? ''}
      maxLength={maxLength}
      dir={dir}
      placeholder={placeholder}
      autoComplete={autoComplete}
      data-testid={testId}
      onInput={(e) => onValue(e.currentTarget.value)}
    />
  );
}

export function TextArea({
  value,
  onValue,
  testId,
  maxLength = 2000,
  ...a11y
}: A11yProps & {
  value: string | null | undefined;
  onValue: (v: string) => void;
  testId?: string;
  maxLength?: number;
}) {
  return (
    <textarea
      {...a11y}
      class="control"
      rows={3}
      value={value ?? ''}
      maxLength={maxLength}
      data-testid={testId}
      onInput={(e) => onValue(e.currentTarget.value)}
    />
  );
}

/** Arabic-Indic and Extended Arabic-Indic digits → ASCII; Arabic decimal separator → '.'. */
export function normalizeDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c >= 0x660 && c <= 0x669) out += String(c - 0x660);
    else if (c >= 0x6f0 && c <= 0x6f9) out += String(c - 0x6f0);
    else if (c === 0x66b) out += '.';
    else if (c === 0x66c)
      continue; // Arabic thousands separator
    else out += ch;
  }
  return out;
}

/** '' → null, a number → the number, anything else → NaN (validation reports it). */
export function parseNumber(text: string): number | null {
  const s = normalizeDigits(text).trim().replace(',', '.');
  if (s === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return Number.NaN;
  return Number(s);
}

const sameNumber = (a: number | null, b: number | null | undefined): boolean =>
  (a === null && (b === null || b === undefined)) ||
  (typeof a === 'number' &&
    typeof b === 'number' &&
    (a === b || (Number.isNaN(a) && Number.isNaN(b))));

/**
 * Number field as `type="text"` + numeric keyboard: accepts Arabic digits and keeps what was
 * typed visible when it is not a number (the inline error explains).
 */
export function NumberInput({
  value,
  onValue,
  testId,
  decimal = false,
  placeholder,
  ...a11y
}: A11yProps & {
  value: number | null | undefined;
  onValue: (v: number | null) => void;
  testId?: string;
  decimal?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  useEffect(() => {
    if (!sameNumber(parseNumber(text), value)) {
      setText(value === null || value === undefined || Number.isNaN(value) ? '' : String(value));
    }
    // Only an outside change of the value (restore, geofill) rewrites the text.
  }, [value]);
  return (
    <input
      {...a11y}
      type="text"
      inputMode={decimal ? 'decimal' : 'numeric'}
      class="control ltr-num"
      dir="ltr"
      value={text}
      placeholder={placeholder}
      autoComplete="off"
      data-testid={testId}
      onInput={(e) => {
        const next = e.currentTarget.value;
        setText(next);
        onValue(parseNumber(next));
      }}
    />
  );
}

export function DateInput({
  value,
  onValue,
  testId,
  ...a11y
}: A11yProps & {
  value: string | null | undefined;
  onValue: (v: string | null) => void;
  testId?: string;
}) {
  return (
    <input
      {...a11y}
      type="date"
      class="control"
      value={value ?? ''}
      data-testid={testId}
      onInput={(e) => onValue(e.currentTarget.value || null)}
    />
  );
}

/** Yes / no / not known (nullable boolean columns). */
export function TriState({
  value,
  onValue,
  testId,
  ...a11y
}: A11yProps & {
  value: boolean | null | undefined;
  onValue: (v: boolean | null) => void;
  testId?: string;
}) {
  const options: SelectOption[] = [
    { value: 'true', label: enumLabel('boolean', 'true') },
    { value: 'false', label: enumLabel('boolean', 'false') },
  ];
  return (
    <Select
      {...a11y}
      aria-invalid={
        a11y['aria-invalid'] === true || a11y['aria-invalid'] === 'true' ? 'true' : undefined
      }
      options={options}
      value={value === true ? 'true' : value === false ? 'false' : ''}
      placeholder={t('form.unknown')}
      testId={testId}
      onChange={(v) => onValue(v === 'true' ? true : v === 'false' ? false : null)}
    />
  );
}

/** Select of an enumerated column, labels from `enum.<key>.<code>`. */
export function EnumSelect({
  enumKey,
  codes,
  value,
  onValue,
  testId,
  placeholder,
  ...a11y
}: A11yProps & {
  enumKey: string;
  codes: readonly string[];
  value: string | null | undefined;
  onValue: (v: string | null) => void;
  testId?: string;
  placeholder?: string;
}) {
  return (
    <Select
      {...a11y}
      aria-invalid={
        a11y['aria-invalid'] === true || a11y['aria-invalid'] === 'true' ? 'true' : undefined
      }
      options={codes.map((c) => ({ value: c, label: enumLabel(enumKey, c) }))}
      value={value ?? ''}
      placeholder={placeholder ?? t('form.choose')}
      testId={testId}
      onChange={(v) => onValue(v === '' ? null : v)}
    />
  );
}

/**
 * Collapsible optional section (brief §7.1: optional sections start folded). The body is
 * rendered only while open, so a folded section costs nothing on a low-end phone.
 */
export function Collapsible({
  id,
  title,
  open,
  onToggle,
  filled,
  restricted,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  filled?: boolean;
  restricted?: boolean;
  children: ComponentChildren;
}) {
  const bodyId = `pf-section-${id}`;
  return (
    <section class={open ? 'pf-fold pf-fold--open' : 'pf-fold'} data-section={id}>
      <h3 class="pf-fold__head">
        <button
          type="button"
          class="pf-fold__toggle"
          aria-expanded={open ? 'true' : 'false'}
          aria-controls={bodyId}
          data-testid={`form-section-${id}`}
          onClick={() => onToggle(!open)}
        >
          <span class="pf-fold__title">{title}</span>
          {restricted && <span class="pf-tag pf-tag--restricted">{t('form.restrictedTag')}</span>}
          {filled && <span class="pf-tag">{t('form.sectionFilled')}</span>}
          <svg
            class="pf-fold__chevron"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </h3>
      <div id={bodyId} class="pf-fold__body" hidden={!open}>
        {open ? children : null}
      </div>
    </section>
  );
}
