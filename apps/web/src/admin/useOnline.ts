import { useEffect, useState } from 'preact/hooks';
import { isOnline } from './api';

/** `navigator.onLine`, updated on the `online` / `offline` events. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(isOnline());
  useEffect(() => {
    const update = (): void => setOnline(isOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}
