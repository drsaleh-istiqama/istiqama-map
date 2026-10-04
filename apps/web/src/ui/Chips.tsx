import { IconCheck } from './icons';

export interface ChipOption {
  value: string;
  label: string;
}

interface ChipsBase {
  options: readonly ChipOption[];
  disabled?: boolean;
  /** Accessible name when the chips are not inside a <Field>. */
  label?: string;
  /** Each chip gets `data-testid="<testId>-<value>"`. */
  testId?: string;
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

/**
 * Quick-pick chips (v2 "quick options"): toggle buttons large enough for a thumb.
 * `multiple` keeps the options in their listed order regardless of the order of the taps.
 */
export function Chips(props: ChipsProps) {
  const { options, disabled, label, testId } = props;
  const selected = new Set<string>(props.multiple ? props.value : props.value ? [props.value] : []);

  const toggle = (value: string): void => {
    if (props.multiple) {
      const next = new Set(selected);
      if (!next.delete(value)) next.add(value);
      props.onChange(options.map((o) => o.value).filter((v) => next.has(v)));
    } else {
      props.onChange(selected.has(value) ? null : value);
    }
  };

  return (
    <div class="chips" role="group" aria-label={label}>
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
    </div>
  );
}
