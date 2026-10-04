import { signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { t } from '../i18n';
import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Defaults to "Confirm". Name the action: "Delete", "Discard changes", "Sign out". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive action: red confirm button. */
  danger?: boolean;
}

interface Request extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

const current = signal<Request | null>(null);
const waiting: Request[] = [];
let host: HTMLElement | null = null;

/** Exactly one view exists, in its own container, however many times the host is requested. */
function ensureHost(): void {
  if (typeof document === 'undefined' || host?.isConnected) return;
  if (host) render(null, host);
  host = document.createElement('div');
  host.dataset.uiHost = 'confirm';
  document.body.appendChild(host);
  render(<ConfirmDialogView />, host);
}

/**
 * Asks the user to confirm. Resolves true only when the confirm button is pressed;
 * Esc and "Cancel" resolve false. Requests are shown one at a time, in order.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  ensureHost();
  return new Promise<boolean>((resolve) => {
    const request: Request = { ...options, resolve };
    if (current.value) waiting.push(request);
    else current.value = request;
  });
}

function settle(confirmed: boolean): void {
  const request = current.value;
  if (!request) return;
  current.value = waiting.shift() ?? null;
  request.resolve(confirmed);
}

function ConfirmDialogView() {
  const request = current.value;
  if (!request) return null;
  return (
    <Modal
      open
      title={request.title}
      onClose={() => settle(false)}
      role="alertdialog"
      size="sm"
      testId="confirm-dialog"
      hideCloseButton
      footer={
        <>
          <Button testId="confirm-cancel" data-autofocus onClick={() => settle(false)}>
            {request.cancelLabel ?? t('ui.cancel')}
          </Button>
          <Button
            variant={request.danger ? 'danger' : 'primary'}
            testId="confirm-ok"
            onClick={() => settle(true)}
          >
            {request.confirmLabel ?? t('ui.confirm')}
          </Button>
        </>
      }
    >
      {request.message && <p>{request.message}</p>}
    </Modal>
  );
}

/**
 * Host for `confirm()`. The app shell mounts it once so the dialog is ready before the first
 * request; `confirm()` also creates it on demand, so isolated views and tests work without it.
 */
export function ConfirmDialog() {
  useEffect(ensureHost, []);
  return null;
}
