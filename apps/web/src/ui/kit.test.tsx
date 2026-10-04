/** Smaller UI-kit pieces: Field, Select, Chips, Button, Toast, Link and the hooks. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import Dexie from 'dexie';
import { useRef } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../i18n';
import { currentRoute, navigate } from '../routes';
import { Button } from './Button';
import { Chips } from './Chips';
import { Field, fieldIds } from './Field';
import { focusableElements, useDebounced, useFocusTrap, useLiveQuery } from './hooks';
import { Link } from './Link';
import { Select } from './Select';
import { dismissToast, toast } from './Toast';

beforeEach(async () => {
  await setLocale('en');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('<Field>', () => {
  it('links label, hint and inline error to the control', () => {
    render(
      <Field
        label="Project name"
        htmlFor="name"
        required
        hint="As written on the sign"
        error="The name is required"
      >
        <input data-testid="control" />
      </Field>,
    );
    const control = screen.getByTestId('control');
    const ids = fieldIds('name');
    expect(control.id).toBe('name');
    expect(screen.getByLabelText(/Project name/)).toBe(control);
    expect(control.getAttribute('aria-describedby')).toBe(`${ids.hint} ${ids.error}`);
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect((control as HTMLInputElement).required).toBe(true);
    expect(document.getElementById(ids.error)?.textContent).toBe('The name is required');
    expect(document.getElementById(ids.error)?.getAttribute('role')).toBe('alert');
    expect(document.getElementById(ids.hint)?.textContent).toBe('As written on the sign');
    // The required mark is visible, and announced in words rather than as "star".
    expect(screen.getByText('*').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('(required)', { exact: false })).toBeTruthy();
  });

  it('adds nothing when there is no hint or error, and keeps an existing describedby', () => {
    render(
      <Field label="Capacity" htmlFor="capacity">
        <input data-testid="control" aria-describedby="unit" />
      </Field>,
    );
    const control = screen.getByTestId('control');
    expect(control.getAttribute('aria-describedby')).toBe('unit');
    expect(control.getAttribute('aria-invalid')).toBeNull();
    expect((control as HTMLInputElement).required).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('wraps several controls in a labelled group', () => {
    render(
      <Field label="Type" htmlFor="type" error="Choose a type">
        <button>Mosque</button>
        <button>School</button>
      </Field>,
    );
    const group = screen.getByRole('group');
    expect(group.getAttribute('aria-labelledby')).toBe(fieldIds('type').label);
    expect(group.getAttribute('aria-describedby')).toBe(fieldIds('type').error);
  });

  it('wires a <Select> the same way', () => {
    const onChange = vi.fn();
    render(
      <Field label="Status" htmlFor="status" error="Required">
        <Select
          testId="status"
          value=""
          placeholder="Choose…"
          onChange={onChange}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'maintenance', label: 'Needs maintenance' },
          ]}
        />
      </Field>,
    );
    const select = screen.getByTestId('status') as HTMLSelectElement;
    expect(select.id).toBe('status');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect([...select.options].map((o) => o.value)).toEqual(['', 'active', 'maintenance']);
    fireEvent.change(select, { target: { value: 'maintenance' } });
    expect(onChange).toHaveBeenCalledWith('maintenance');
  });
});

describe('<Chips>', () => {
  const options = [
    { value: 'farming', label: 'Farming' },
    { value: 'fishing', label: 'Fishing' },
    { value: 'trade', label: 'Trade' },
  ];

  it('multiple: toggles values and keeps them in option order', () => {
    const onChange = vi.fn();
    render(
      <Chips
        multiple
        options={options}
        value={['trade']}
        onChange={onChange}
        testId="livelihood"
        label="Livelihoods"
      />,
    );
    expect(screen.getByRole('group').getAttribute('aria-label')).toBe('Livelihoods');
    expect(screen.getByTestId('livelihood-trade').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('livelihood-farming').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByTestId('livelihood-farming'));
    expect(onChange).toHaveBeenLastCalledWith(['farming', 'trade']);
    fireEvent.click(screen.getByTestId('livelihood-trade'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('single: selects one value, and pressing it again clears it', () => {
    const onChange = vi.fn();
    const view = render(<Chips options={options} value={null} onChange={onChange} testId="one" />);
    fireEvent.click(screen.getByTestId('one-fishing'));
    expect(onChange).toHaveBeenLastCalledWith('fishing');
    view.rerender(<Chips options={options} value="fishing" onChange={onChange} testId="one" />);
    expect(screen.getByTestId('one-fishing').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('one-fishing'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe('<Button>', () => {
  it('is type="button" by default and blocks clicks while busy', () => {
    const onClick = vi.fn();
    const view = render(
      <Button variant="primary" testId="save" onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByTestId('save') as HTMLButtonElement;
    expect(button.type).toBe('button');
    expect(button.className).toContain('btn--primary');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    view.rerender(
      <Button variant="primary" testId="save" busy onClick={onClick}>
        Save
      </Button>,
    );
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});

describe('toast()', () => {
  it('announces messages in a role="status" live region and removes them after a while', async () => {
    vi.useFakeTimers();
    toast('Saved on this device', 'success');
    await vi.advanceTimersByTimeAsync(0);
    const region = screen.getByTestId('toasts');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByTestId('toast-success').textContent).toContain('Saved on this device');

    await vi.advanceTimersByTimeAsync(4100);
    expect(screen.queryByTestId('toast-success')).toBeNull();
    expect(screen.getByTestId('toasts')).toBeTruthy(); // the region itself stays
  });

  it('keeps errors longer, never stacks a repeated message and shows at most three', async () => {
    vi.useFakeTimers();
    toast('Upload failed', 'error');
    toast('Upload failed', 'error');
    await vi.advanceTimersByTimeAsync(4100);
    expect(screen.getAllByTestId('toast-error')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4100);
    expect(screen.queryByTestId('toast-error')).toBeNull();

    for (const message of ['one', 'two', 'three', 'four']) toast(message);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getAllByTestId('toast-info').map((el) => el.textContent)).toEqual([
      'two',
      'three',
      'four',
    ]);
    await vi.advanceTimersByTimeAsync(5000);
  });

  it('can be dismissed by the user', async () => {
    toast('Dismiss me');
    const item = await screen.findByTestId('toast-info');
    fireEvent.click(item.querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByTestId('toast-info')).toBeNull());
    dismissToast(999); // unknown id: no error
  });
});

describe('<Link>', () => {
  beforeEach(() => navigate('/map', { replace: true }));

  it('navigates in-app on a plain click and keeps a real href', () => {
    render(
      <Link href="/reports" testId="link">
        Reports
      </Link>,
    );
    const link = screen.getByTestId('link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/reports');
    fireEvent.click(link);
    expect(currentRoute.value.path).toBe('/reports');
  });

  it('leaves modified clicks to the browser and respects preventDefault', () => {
    render(
      <>
        <Link href="/reports" testId="modified">
          a
        </Link>
        <Link href="/people" testId="cancelled" onClick={(event) => event.preventDefault()}>
          b
        </Link>
      </>,
    );
    fireEvent.click(screen.getByTestId('modified'), { ctrlKey: true });
    fireEvent.click(screen.getByTestId('cancelled'));
    expect(currentRoute.value.path).toBe('/map');
  });
});

describe('hooks', () => {
  it('useDebounced waits for the value to settle', async () => {
    vi.useFakeTimers();
    function Probe({ value }: { value: string }) {
      return <span data-testid="out">{useDebounced(value, 250)}</span>;
    }
    const view = render(<Probe value="a" />);
    view.rerender(<Probe value="ab" />);
    view.rerender(<Probe value="abc" />);
    expect(screen.getByTestId('out').textContent).toBe('a');
    await vi.advanceTimersByTimeAsync(249);
    expect(screen.getByTestId('out').textContent).toBe('a');
    await vi.advanceTimersByTimeAsync(2);
    expect(screen.getByTestId('out').textContent).toBe('abc');
  });

  it('useFocusTrap keeps Tab inside and gives focus back', async () => {
    function Trap({ active }: { active: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, active);
      return (
        <div ref={ref} data-testid="trap">
          <button data-testid="one">1</button>
          <button data-testid="two" hidden>
            hidden
          </button>
          <button data-testid="three">3</button>
        </div>
      );
    }
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    const view = render(<Trap active />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('one')));
    expect(focusableElements(screen.getByTestId('trap')).map((el) => el.dataset.testid)).toEqual([
      'one',
      'three',
    ]);

    screen.getByTestId('three').focus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('one'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('three'));

    view.rerender(<Trap active={false} />);
    await waitFor(() => expect(document.activeElement).toBe(outside));
    outside.remove();
  });

  it('useLiveQuery re-runs on Dexie changes and unsubscribes on unmount', async () => {
    const db = new Dexie(`live-query-test-${Math.random()}`) as Dexie & {
      items: Dexie.Table<{ id: number; name: string }, number>;
    };
    db.version(1).stores({ items: 'id' });
    await db.items.put({ id: 1, name: 'one' });
    const query = vi.fn(() => db.items.count());

    function Counter() {
      const count = useLiveQuery(query, []);
      return <span data-testid="count">{count === undefined ? 'loading' : String(count)}</span>;
    }
    const view = render(<Counter />);
    expect(screen.getByTestId('count').textContent).toBe('loading');
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));

    await db.items.put({ id: 2, name: 'two' });
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('2'));

    view.unmount();
    // Preact runs passive clean-ups after paint: give the unsubscribe a moment.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const callsAfterUnmount = query.mock.calls.length;
    await db.items.put({ id: 3, name: 'three' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(query.mock.calls.length).toBe(callsAfterUnmount);
    db.close();
  });
});
