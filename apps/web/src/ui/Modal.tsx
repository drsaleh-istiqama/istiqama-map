import { createPortal, type ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef } from 'preact/hooks';
import { t } from '../i18n';
import { useFocusTrap } from './hooks';
import { IconClose } from './icons';

export interface ModalProps {
  open: boolean;
  title: string;
  /** Called when the dialog may really close (after `confirmClose` agreed, when given). */
  onClose: () => void;
  /** Default false: a click outside the dialog does nothing. */
  closeOnBackdrop?: boolean;
  /**
   * Guard for unsaved work (brief §7.4). Esc, the close button and — when enabled — the
   * backdrop never close directly: they ask this function first and stay open unless it
   * resolves to true.
   */
  confirmClose?: () => boolean | Promise<boolean>;
  testId?: string;
  size?: 'sm' | 'md' | 'lg';
  /** `sheet` docks to the bottom edge on phones (navigation "more" menu). */
  variant?: 'dialog' | 'sheet';
  role?: 'dialog' | 'alertdialog';
  /** Buttons row under the body. */
  footer?: ComponentChildren;
  hideCloseButton?: boolean;
  children?: ComponentChildren;
}

/** Open dialogs, topmost last: only the topmost one answers Esc. */
const stack: symbol[] = [];

function lockPageScroll(locked: boolean): void {
  document.documentElement.classList.toggle('has-modal', locked);
}

export function Modal(props: ModalProps) {
  return props.open ? <ModalWindow {...props} /> : null;
}

function ModalWindow({
  title,
  onClose,
  closeOnBackdrop = false,
  confirmClose,
  testId,
  size = 'md',
  variant = 'dialog',
  role = 'dialog',
  footer,
  hideCloseButton,
  children,
}: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const asking = useRef(false);
  // Always call the latest callbacks without re-subscribing the key listener.
  const latest = useRef({ onClose, confirmClose });
  latest.current = { onClose, confirmClose };

  useFocusTrap(dialogRef, true);

  const requestClose = async (): Promise<void> => {
    if (asking.current) return;
    const { onClose: close, confirmClose: confirm } = latest.current;
    if (!confirm) {
      close();
      return;
    }
    asking.current = true;
    try {
      if (await confirm()) latest.current.onClose();
    } finally {
      asking.current = false;
    }
  };

  // Layout effect so the stack and the scroll lock are released in the commit that closes the dialog.
  useLayoutEffect(() => {
    const token = Symbol('modal');
    stack.push(token);
    lockPageScroll(true);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || stack[stack.length - 1] !== token) return;
      event.preventDefault();
      event.stopPropagation();
      void requestClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = stack.indexOf(token);
      if (index >= 0) stack.splice(index, 1);
      lockPageScroll(stack.length > 0);
    };
  }, []);

  return createPortal(
    <div
      class={`modal-layer modal-layer--${variant}`}
      data-testid={testId ? `${testId}-backdrop` : undefined}
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) void requestClose();
      }}
    >
      <div
        ref={dialogRef}
        class={`modal modal--${size}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
      >
        <header class="modal__head">
          <h2 class="modal__title" id={titleId}>
            {title}
          </h2>
          {!hideCloseButton && (
            <button
              type="button"
              class="icon-btn"
              aria-label={t('ui.close')}
              data-testid={testId ? `${testId}-close` : undefined}
              onClick={() => void requestClose()}
            >
              <IconClose />
            </button>
          )}
        </header>
        <div class="modal__body">{children}</div>
        {footer && <footer class="modal__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
