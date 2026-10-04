/**
 * Small building blocks shared by the panels of the console: a loader hook that respects
 * the offline rule of web.md §1, the loading / error / offline states, and a dirty-aware
 * close guard for dialogs (brief §7.4: Esc or the backdrop never discards typed data).
 */
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { fmt, t } from '../i18n';
import { Button, confirm, EmptyState, IconAlert, IconOffline, Spinner } from '../ui';
import { isOnline } from './api';
import { adminErrorKey } from './errors';
import type { FieldError } from './validate';

export interface Resource<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  offline: boolean;
  /** Re-run the loader; resolves when done (errors are kept in `error`). */
  reload: () => Promise<void>;
  /** Replace the data locally (after a write that returned the new row). */
  setData: (update: (previous: T | null) => T | null) => void;
}

/**
 * Loads `load()` when mounted and whenever `deps` change. Without a connection nothing is
 * requested (`offline` is set) and the loader runs again on the `online` event.
 */
export function useResource<T>(load: () => Promise<T>, deps: unknown[] = []): Resource<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const generation = useRef(0);
  const latest = useRef(load);
  latest.current = load;

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++generation.current;
    if (!isOnline()) {
      setOffline(true);
      setLoading(false);
      return;
    }
    setOffline(false);
    setLoading(true);
    try {
      const value = await latest.current();
      if (mine !== generation.current) return;
      setDataState(() => value);
      setError(null);
    } catch (e) {
      if (mine !== generation.current) return;
      setError(e);
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onOnline = (): void => void reload();
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      generation.current++;
    };
  }, deps);

  const setData = useCallback((update: (previous: T | null) => T | null) => {
    setDataState((previous) => update(previous));
  }, []);

  return { data, error, loading, offline, reload, setData };
}

/** Loading / offline / error states of a panel; renders `children` once data is there. */
export function ResourceState<T>({
  resource,
  testId,
  children,
}: {
  resource: Resource<T>;
  testId: string;
  children: (data: T) => ComponentChildren;
}) {
  if (resource.offline && resource.data === null) {
    return (
      <EmptyState
        testId={`${testId}-offline`}
        icon={<IconOffline size={40} />}
        title={t('admin.offlineTitle')}
        message={t('admin.offlineBody')}
      />
    );
  }
  if (resource.error && resource.data === null) {
    return (
      <EmptyState
        testId={`${testId}-error`}
        icon={<IconAlert size={40} />}
        title={t('admin.loadErrorTitle')}
        message={t(adminErrorKey(resource.error))}
        action={
          <Button
            variant="primary"
            testId={`${testId}-retry`}
            onClick={() => void resource.reload()}
          >
            {t('admin.retry')}
          </Button>
        }
      />
    );
  }
  if (resource.data === null) {
    return (
      <div class="spinner-block" data-testid={`${testId}-loading`}>
        <Spinner />
      </div>
    );
  }
  return <>{children(resource.data)}</>;
}

/** Message of a field error (locale key + parameters). */
export function errorText(error: FieldError | undefined | null): string | null {
  return error ? t(error.key, error.params) : null;
}

/**
 * `confirmClose` for a dialog with a form: closes at once when nothing was changed,
 * otherwise asks before discarding.
 */
export function useCloseGuard(dirty: boolean): () => Promise<boolean> {
  const ref = useRef(dirty);
  ref.current = dirty;
  return useCallback(async () => {
    if (!ref.current) return true;
    return confirm({
      title: t('admin.discardTitle'),
      message: t('admin.discardBody'),
      confirmLabel: t('admin.discard'),
      cancelLabel: t('admin.keepEditing'),
      danger: true,
    });
  }, []);
}

/** "3 minutes ago" with the exact time as a tooltip; a dash when never. */
export function When({ at, testId }: { at: string | null | undefined; testId?: string }) {
  if (!at) {
    return (
      <span class="muted" data-testid={testId}>
        {t('admin.never')}
      </span>
    );
  }
  return (
    <time dateTime={at} title={fmt.dateTime(at)} data-testid={testId}>
      {fmt.relative(at)}
    </time>
  );
}

/** Latin-only fragment (codes, e-mails, phones, device ids) isolated inside RTL text. */
export function Ltr({ children, class: extra }: { children: ComponentChildren; class?: string }) {
  return (
    <bdi dir="ltr" class={extra ? `adm-ltr ${extra}` : 'adm-ltr'}>
      {children}
    </bdi>
  );
}

/** Inline form-level error (role="alert") under a dialog's fields. */
export function FormError({ message, testId }: { message: string | null; testId: string }) {
  if (!message) return null;
  return (
    <p class="adm-form-error" role="alert" data-testid={testId}>
      <IconAlert size={18} /> <span>{message}</span>
    </p>
  );
}
