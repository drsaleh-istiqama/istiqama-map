import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { fieldIds } from './Field';
import { IconCheck } from './icons';

export interface ChipOption {
  value: string;
  label: string;
}

/**
 * The "Other" chip of v2's quick options: pressing it reveals a short free-text box whose
 * content is stored next to the chosen codes (`<list>_other` columns, docs/V2_PARITY.md 4.6).
 * Pressing it again hides the box and clears the text.
 */
export interface ChipsOther {
  value: string;
  onChange: (text: string) => void;
  /** Placeholder and accessible name of the text box (default: "Type a short addition"). */
  placeholder?: string;
  /** Default 240 characters, as in v2. */
  maxLength?: number;
}

interface ChipsBase {
  options: readonly ChipOption[];
  disabled?: boolean;
  /** Accessible name when the chips are not inside a <Field>. */
  label?: string;
  /** Each chip gets `data-testid="<testId>-<value>"`; the "Other" chip `<testId>-other`. */
  testId?: string;
  /** Adds the "Other" chip with its free-text box. */
  other?: ChipsOther;
  /** Set by <Field>: the group is then named by the field label and described by its hint / error. */
  id?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: 'true' | 'false';
}

export interface MultiChipsProps extends ChipsBase {
  multiple: true;
  value: readonly string[];
  onChange: (value: string[]) => void;
}

export interface SingleChipsProps extends ChipsBase {
  multiple?: false;
  value: string | null | undefined;
  /** Pressing the selected chip again clears the choice (null). */
  onChange: (value: string | null) => void;
}

export type ChipsProps = MultiChipsProps | SingleChipsProps;

export const OTHER_MAX_LENGTH = 240;

/**
 * Quick-pick chips (v2 "quick options"): toggle buttons large enough for a thumb.
 * `multiple` keeps the options in their listed order regardless of the order of the taps.
 */
export function Chips(props: ChipsProps) {
  const { options, disabled, label, testId, other, id } = props;
  const selected = new Set<string>(props.multiple ? props.value : props.value ? [props.value] : []);
  const [otherToggled, setOtherToggled] = useState(false);
  const otherInput = useRef<HTMLInputElement>(null);
  const focusOther = useRef(false);
  // A restored draft with text in "Other" opens the box by itself.
  const otherOpen = Boolean(other) && (otherToggled || (other?.value ?? '') !== '');
  const otherId = id ? `${id}-other` : undefined;

  useEffect(() => {
    if (!focusOther.current) return;
    focusOther.current = false;
    otherInput.current?.focus();
  });

  const toggle = (value: string): void => {
    if (props.multiple) {
      const next = new Set(selected);
      if (!next.delete(value)) next.add(value);
      props.onChange(options.map((o) => o.value).filter((v) => next.has(v)));
    } else {
      props.onChange(selected.has(value) ? null : value);
    }
  };

  const toggleOther = (): void => {
    if (!other) return;
    if (otherOpen) {
      setOtherToggled(false);
      if (other.value !== '') other.onChange('');
    } else {
      setOtherToggled(true);
      focusOther.current = true;
    }
  };

  const labelledBy = props['aria-labelledby'] ?? (id && !label ? fieldIds(id).label : undefined);

  return (
    <div class="chips-field">
      <div
        class="chips"
        role="group"
        id={id}
        aria-label={label}
        aria-labelledby={label ? undefined : labelledBy}
        aria-describedby={props['aria-describedby']}
        aria-invalid={props['aria-invalid']}
      >
        {options.map((option) => {
          const on = selected.has(option.value);
          return (
            <button
              key={option.value}
              type="button"
              class={on ? 'chip chip--on' : 'chip'}
              aria-pressed={on ? 'true' : 'false'}
              disabled={disabled}
              data-testid={testId ? `${testId}-${option.value}` : undefined}
              onClick={() => toggle(option.value)}
            >
              {on && <IconCheck size={16} />}
              <span>{option.label}</span>
            </button>
          );
        })}
        {other && (
          <button
            type="button"
            class={otherOpen ? 'chip chip--on' : 'chip'}
            aria-pressed={otherOpen ? 'true' : 'false'}
            aria-expanded={otherOpen ? 'true' : 'false'}
            aria-controls={otherOpen ? otherId : undefined}
            disabled={disabled}
            data-testid={testId ? `${testId}-other` : undefined}
            onClick={toggleOther}
          >
            {otherOpen && <IconCheck size={16} />}
            <span>{t('ui.other')}</span>
          </button>
        )}
      </div>
      {other && otherOpen && (
        <input
          ref={otherInput}
          id={otherId}
          type="text"
          class="control chips__other"
          value={other.value}
          maxLength={other.maxLength ?? OTHER_MAX_LENGTH}
          placeholder={other.placeholder ?? t('ui.otherPlaceholder')}
          aria-label={other.placeholder ?? t('ui.otherPlaceholder')}
          disabled={disabled}
          data-testid={testId ? `${testId}-other-text` : undefined}
          onInput={(event) => other.onChange(event.currentTarget.value)}
        />
      )}
    </div>
  );
}
