/**
 * The single Supabase client of the web app (docs/contracts/web.md §3.6).
 *
 * - `x-device-id` on every request (REST, Auth, Storage, Functions).
 * - Session storage = the PIN vault: tokens exist in memory while unlocked and encrypted in
 *   IndexedDB otherwise; never in localStorage.
 * - Implicit flow with `detectSessionInUrl`: a magic link opened on this device signs in. PKCE
 *   is not used because its code verifier would have to be persisted unencrypted across the
 *   redirect.
 * - Only the anon key is ever present in the browser.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env';
import { deviceId } from './device';
import { createGuardedFetch, urlHasAuthCallback } from './net';
import { STORAGE_KEY, vault } from './store';

// A magic link may replace a locked vault: the owner of the mailbox just proved who they are.
if (typeof window !== 'undefined' && urlHasAuthCallback(window.location.href)) {
  vault.expectFreshSignIn();
}

// Unit tests of other modules import this file without a configured environment (CI has no
// .env.local). Everywhere else a missing URL must fail loudly, which createClient does.
const testMode = import.meta.env.MODE === 'test';
const supabaseUrl = env.supabaseUrl || (testMode ? 'http://127.0.0.1:54321' : '');
const supabaseAnonKey = env.supabaseAnonKey || (testMode ? 'anon-key-for-unit-tests' : '');

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: vault.storage,
    storageKey: STORAGE_KEY,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'implicit',
  },
  global: {
    headers: { 'x-device-id': deviceId() },
    fetch: createGuardedFetch(supabaseUrl),
  },
});
