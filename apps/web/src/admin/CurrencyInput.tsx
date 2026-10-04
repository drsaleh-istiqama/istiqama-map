/**
 * ISO 4217 code input with the brief's currencies as suggestions (a native datalist: any
 * other three-letter code can still be typed). Works as the single control of a <Field>.
 */
import { t } from '../i18n';
import { KNOWN_CURRENCIES } from './validate';

export function CurrencyInput({
  value,
  onChange,
  testId,
  id,
  required,
  disabled,
  ...aria
}: {
  value: string;
  onChange: (value: string) => void;
  testId: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: 'true' | 'false' | boolean;
}) {
  const listId = `${id ?? testId}-suggestions`;
  return (
    <>
      <input
        {...aria}
        id={id}
        class="control mono adm-code-input"
        dir="ltr"
        list={listId}
        maxLength={3}
        required={required}
        disabled={disabled}
        autocomplete="off"
        autocapitalize="characters"
        spellcheck={false}
        data-testid={testId}
        value={value}
        onInput={(e) => onChange(e.currentTarget.value.toUpperCase())}
      />
      <datalist id={listId}>
        {KNOWN_CURRENCIES.map((code) => (
          <option key={code} value={code}>
            {t(`enum.currency.${code}`)}
          </option>
        ))}
      </datalist>
    </>
  );
}
