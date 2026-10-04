import { signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { t } from '../i18n';
import { IconAlert, IconCheck, IconClose, IconInfo } from './icons';

export type ToastKind = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

const MAX_VISIBLE = 3;
const LIFETIME_MS: Record<ToastKind, number> = { info: 4000, success: 4000, error: 8000 };

const items = signal<ToastItem[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextId = 1;
let host: HTMLElement | null = null;

function ensureHost(): void {
  if (typeof document === 'undefined' || host?.isConnected) return;
  if (host) render(null, host);
  host = document.createElement('div');
  host.dataset.uiHost = 'toast';
  document.body.appendChild(host);
  render(<ToastView />, host);
}

function schedule(item: ToastItem): void {
  clearTimeout(timers.get(item.id));
  timers.set(
    item.id,
    setTimeout(() => dismissToast(item.id), LIFETIME_MS[item.kind]),
  );
}

export function dismissToast(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  items.value = items.value.filter((item) => item.id !== id);
}

/** Short, non-blocking message. Errors stay longer; a repeated message restarts its timer instead of stacking. */
export function toast(message: string, kind: ToastKind = 'info'): void {
  ensureHost();
  const existing = items.value.find((item) => item.message === message && item.kind === kind);
  if (existing) {
    schedule(existing);
    return;
  }
  const item: ToastItem = { id: nextId++, message, kind };
  const next = [...items.value, item];
  for (const dropped of next.slice(0, Math.max(0, next.length - MAX_VISIBLE))) {
    clearTimeout(timers.get(dropped.id));
    timers.delete(dropped.id);
  }
  items.value = next.slice(-MAX_VISIBLE);
  schedule(item);
}

const ICONS = { info: IconInfo, success: IconCheck, error: IconAlert } as const;

function ToastView() {
  return (
    // The live region exists before any message so screen readers announce additions.
    <div class="toasts" role="status" aria-live="polite" data-testid="toasts">
      {items.value.map((item) => {
        const Icon = ICONS[item.kind];
        return (
          <div key={item.id} class={`toast toast--${item.kind}`} data-testid={`toast-${item.kind}`}>
            <Icon size={20} />
            <span class="toast__text">{item.message}</span>
            <button
              type="button"
              class="icon-btn icon-btn--sm"
              aria-label={t('ui.dismiss')}
              onClick={() => dismissToast(item.id)}
            >
              <IconClose size={18} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Host for `toast()`. The app shell mounts it once so the live region exists from the start;
 * `toast()` also creates it on demand.
 */
export function Toast() {
  useEffect(ensureHost, []);
  return null;
}
