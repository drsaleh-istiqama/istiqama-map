/** Small hooks shared by the reports page and the print view. */
import { useEffect, useState } from 'preact/hooks';
import { getAppSetting } from '../db';
import { isOnline } from './api';

/** `navigator.onLine`, updated by the online / offline events. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(isOnline());
  useEffect(() => {
    const on = (): void => setOnline(true);
    const off = (): void => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export const FX_PLACEHOLDER_SETTING = 'fx.placeholder';

/** True while `app_settings['fx.placeholder'].placeholder` says the USD rates are not official. */
export function isFxPlaceholder(value: unknown): boolean {
  return (
    value === true ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { placeholder?: unknown }).placeholder === true)
  );
}

/** The cached public setting (src/db), read once per mount. */
export function useFxPlaceholder(): boolean {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    let alive = true;
    getAppSetting<unknown>(FX_PLACEHOLDER_SETTING, null)
      .then((v) => alive && setFlag(isFxPlaceholder(v)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return flag;
}
