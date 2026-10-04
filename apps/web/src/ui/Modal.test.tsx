import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirm } from './ConfirmDialog';
import { Modal } from './Modal';

afterEach(() => {
  cleanup();
});

function pressTab(shift = false): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: shift });
}
function pressEscape(): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
}

function Harness(props: {
  confirmClose?: () => boolean | Promise<boolean>;
  closeOnBackdrop?: boolean;
  onClosed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button data-testid="opener" onClick={() => setOpen(true)}>
        open
      </button>
      <Modal
        open={open}
        title="Add project"
        testId="dialog"
        confirmClose={props.confirmClose}
        closeOnBackdrop={props.closeOnBackdrop}
        onClose={() => {
          setOpen(false);
          props.onClosed?.();
        }}
      >
        <input data-testid="first" />
        <input data-testid="second" />
        <button data-testid="last">save</button>
      </Modal>
    </div>
  );
}

function open(): HTMLElement {
  const opener = screen.getByTestId('opener');
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe('<Modal>', () => {
  it('is a labelled modal dialog', () => {
    render(<Harness />);
    open();
    const dialog = screen.getByTestId('dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)?.textContent).toBe('Add project');
    expect(document.documentElement.classList.contains('has-modal')).toBe(true);
  });

  it('moves focus inside, traps Tab in both directions and restores focus on close', async () => {
    render(<Harness />);
    const opener = open();
    const dialog = screen.getByTestId('dialog');
    const closeButton = screen.getByTestId('dialog-close');
    const last = screen.getByTestId('last');

    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).toBe(closeButton); // first focusable element

    last.focus();
    pressTab();
    expect(document.activeElement).toBe(closeButton); // wrapped forward

    pressTab(true);
    expect(document.activeElement).toBe(last); // wrapped backward

    // Focus that escapes (e.g. a click outside) is pulled back in.
    opener.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.click(closeButton);
    await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(document.documentElement.classList.contains('has-modal')).toBe(false);
  });

  it('honours [data-autofocus]', async () => {
    render(
      <Modal open title="t" onClose={() => undefined} testId="auto">
        <input data-testid="a" />
        <input data-testid="b" data-autofocus />
      </Modal>,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('b')));
  });

  it('Esc closes directly only when there is nothing to confirm', async () => {
    const onClosed = vi.fn();
    render(<Harness onClosed={onClosed} />);
    open();
    pressEscape();
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('dialog')).toBeNull();
  });

  it('Esc NEVER discards: it asks confirmClose and stays open when the answer is no', async () => {
    const confirmClose = vi.fn(() => false);
    const onClosed = vi.fn();
    render(<Harness confirmClose={confirmClose} onClosed={onClosed} />);
    open();
    fireEvent.input(screen.getByTestId('first'), { target: { value: 'مسجد النور' } });

    pressEscape();
    await waitFor(() => expect(confirmClose).toHaveBeenCalledTimes(1));
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByTestId('dialog')).toBeTruthy();
    expect((screen.getByTestId('first') as HTMLInputElement).value).toBe('مسجد النور');
  });

  it('closes after confirmClose resolves true (also asynchronously)', async () => {
    const confirmClose = vi.fn(() => Promise.resolve(true));
    const onClosed = vi.fn();
    render(<Harness confirmClose={confirmClose} onClosed={onClosed} />);
    open();
    pressEscape();
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    expect(confirmClose).toHaveBeenCalledTimes(1);
  });

  it('the close button goes through confirmClose too', async () => {
    const confirmClose = vi.fn(() => false);
    const onClosed = vi.fn();
    render(<Harness confirmClose={confirmClose} onClosed={onClosed} />);
    open();
    fireEvent.click(screen.getByTestId('dialog-close'));
    await waitFor(() => expect(confirmClose).toHaveBeenCalledTimes(1));
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('does not ask twice while a confirmation is pending', async () => {
    let answer: (value: boolean) => void = () => undefined;
    const confirmClose = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const onClosed = vi.fn();
    render(<Harness confirmClose={confirmClose} onClosed={onClosed} />);
    open();
    pressEscape();
    pressEscape();
    pressEscape();
    expect(confirmClose).toHaveBeenCalledTimes(1);
    answer(true);
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
  });

  it('a click on the backdrop does nothing by default', () => {
    const confirmClose = vi.fn(() => true);
    const onClosed = vi.fn();
    render(<Harness confirmClose={confirmClose} onClosed={onClosed} />);
    open();
    fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'));
    expect(confirmClose).not.toHaveBeenCalled();
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByTestId('dialog')).toBeTruthy();
  });

  it('with closeOnBackdrop the backdrop asks confirmClose; clicks inside the dialog never count', async () => {
    const confirmClose = vi.fn(() => false);
    const onClosed = vi.fn();
    render(<Harness closeOnBackdrop confirmClose={confirmClose} onClosed={onClosed} />);
    open();
    fireEvent.mouseDown(screen.getByTestId('first'));
    expect(confirmClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'));
    await waitFor(() => expect(confirmClose).toHaveBeenCalledTimes(1));
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('with a confirm dialog on top, Esc answers only the topmost dialog and the form survives', async () => {
    const onClosed = vi.fn();
    const confirmClose = (): Promise<boolean> =>
      confirm({ title: 'Discard changes?', confirmLabel: 'Discard', danger: true });
    render(<Harness confirmClose={confirmClose} onClosed={onClosed} />);
    open();

    pressEscape(); // asks…
    const question = await screen.findByTestId('confirm-dialog');
    expect(question.getAttribute('role')).toBe('alertdialog');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('confirm-cancel')));

    pressEscape(); // …Esc on the question = "no, keep editing"
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByTestId('dialog')).toBeTruthy();

    pressEscape();
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
  });
});

describe('confirm()', () => {
  it('resolves true on confirm, false on cancel, and shows requests one at a time', async () => {
    const first = confirm({ title: 'First?', message: 'one', confirmLabel: 'Yes' });
    const second = confirm({ title: 'Second?' });

    expect((await screen.findByTestId('confirm-dialog')).textContent).toContain('First?');
    expect(screen.getAllByTestId('confirm-dialog')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('confirm-ok'));
    await expect(first).resolves.toBe(true);

    await waitFor(() =>
      expect(screen.getByTestId('confirm-dialog').textContent).toContain('Second?'),
    );
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await expect(second).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
  });
});
