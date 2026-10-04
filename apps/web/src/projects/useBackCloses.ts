import { useEffect, useRef } from 'preact/hooks';

type DialogState = { dialog?: unknown } & Record<string, unknown>;

function currentState(): DialogState {
  const state: unknown = window.history.state;
  return state && typeof state === 'object' ? (state as DialogState) : {};
}

/**
 * Android Back (and the browser's back button) while a dialog holding typed text is open.
 *
 * Without this, Back leaves the page: the dialog unmounts and the text is gone without the
 * question Esc and the close button ask (brief §7.4). With it, the open dialog owns a history
 * entry of the same URL (the router keeps the page: same path, same `key` in the state). Back
 * takes that entry off; the entry is put back at once — so the page is never left while the
 * dialog decides, however often Back is pressed — and `requestClose` runs the dialog's own
 * close guard. It resolves true when the dialog closed: the entry is then removed again;
 * false keeps the dialog (and the entry) as they are.
 *
 * When the dialog closes another way (cancel, Esc, submit) its entry is removed, unless a
 * navigation has already replaced it.
 */
export function useBackCloses(open: boolean, requestClose: () => Promise<boolean>): void {
  const latest = useRef(requestClose);
  latest.current = requestClose;

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const token = `dialog-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const ours = (): boolean => currentState().dialog === token;
    const push = (): void => {
      window.history.pushState({ ...currentState(), dialog: token }, '', window.location.href);
    };
    let active = true;
    let asking = false;

    const onPopState = (): void => {
      if (!active || ours()) return;
      push();
      if (asking) return;
      asking = true;
      void Promise.resolve()
        .then(() => latest.current())
        .catch(() => false)
        .finally(() => {
          asking = false;
        });
    };

    push();
    window.addEventListener('popstate', onPopState);
    return () => {
      active = false;
      window.removeEventListener('popstate', onPopState);
      if (ours()) window.history.back();
    };
  }, [open]);
}
