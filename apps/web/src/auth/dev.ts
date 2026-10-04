/**
 * DEVELOPMENT / STAGING ONLY — password sign-in for automated tests (seeded accounts).
 *
 * This file is reachable only through the guarded dynamic import in `devtools.ts`; with
 * `VITE_APP_ENV=production` the guard is a compile-time `false`, the import is removed and this
 * chunk is not emitted. It has no UI.
 *
 *   await window.__istiqamaDev.signInWithPassword('collector.pemba@example.org', '…')
 */
import { toFlowError } from './errors';
import { vault } from './store';
import { supabase } from './supabase';

export async function devSignInWithPassword(email: string, password: string): Promise<void> {
  vault.expectFreshSignIn();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw toFlowError(error);
}

export interface IstiqamaDevTools {
  signInWithPassword: typeof devSignInWithPassword;
}

export function installDevTools(): void {
  (window as unknown as { __istiqamaDev?: IstiqamaDevTools }).__istiqamaDev = {
    signInWithPassword: devSignInWithPassword,
  };
}
