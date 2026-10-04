import { effect } from '@preact/signals';
import { render, type ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type * as AuthModule from './auth';
import { initI18n, t } from './i18n';
import { Button } from './ui/Button';
import { initMonitoring } from './ui/monitoring';
import { registerServiceWorker } from './ui/pwa/register';
import { clearUserTraces, watchSignedOut } from './ui/shell/signOutCleanup';
import { Spinner } from './ui/Spinner';
import { Toast } from './ui/Toast';
import './ui/fonts.css';
import './ui/tokens.css';
import './ui/base.css';
import './ui/ui.css';

type Auth = typeof AuthModule;

/**
 * Loading chain (brief §5, docs/CI.md §6.3) — each step is its own task, after the first paint:
 *
 *   index.html   static splash, inlined critical CSS            → first paint
 *   main.tsx     tiny entry: import('./app')
 *   app.tsx      this chunk: Preact, i18n (Arabic), stylesheets, toasts
 *   supabase-js, Dexie, ./db   evaluated one per task (they are static imports of ./auth)
 *   ./auth       sign-in stack (session, LoginView, PIN lock)   → sign-in screen / PIN lock
 *   Shell        the application chrome, sync engine, views     → only once signed in
 *
 * Every chunk up to ./auth is preloaded from index.html, so the split costs no round trips.
 */

const loadShell = () => import('./ui/shell/Shell').then((module) => module.Shell);
let shell: Promise<ComponentType> | null = null;
let loadedShell: ComponentType | null = null;

/** Starts loading the shell (idempotent); a failed load is retried on the next call. */
function preloadShell(): Promise<ComponentType> {
  shell ??= loadShell().then(
    (component) => (loadedShell = component),
    (error: unknown) => {
      shell = null;
      throw error;
    },
  );
  return shell;
}

/** The shell, loaded on demand: it is precached by the service worker, so this works offline. */
function LazyShell() {
  const [Shell, setShell] = useState<ComponentType | null>(() => loadedShell);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (Shell) return;
    let alive = true;
    preloadShell().then(
      (component) => alive && setShell(() => component),
      (error: unknown) => {
        console.error('[boot] the application shell could not be loaded', error);
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [Shell, failed]);
  if (Shell) return <Shell />;
  if (failed) {
    return (
      <div class="spinner-block" role="alert">
        <Button testId="shell-retry" onClick={() => setFailed(false)}>
          {t('auth.retry')}
        </Button>
      </div>
    );
  }
  return <Spinner block />;
}

/**
 * Root component. `AuthGate` (auth team) decides between sign-in, MFA, the PIN lock and the
 * application; the shell renders only for a signed-in, unlocked user. Toasts live outside the
 * gate so the sign-in screens can use them too; the confirm dialog mounts itself on first use
 * (`confirm()` in ui/ConfirmDialog), so it is not part of the first screen.
 */
export function App({ auth }: { auth: Auth }) {
  useEffect(() => {
    // However the session ended, the next person on this device sees nothing of the last one.
    const stopCleanup = watchSignedOut(auth.authState, clearUserTraces);
    // Past the sign-in screen (PIN lock, PIN setup, MFA…): fetch the shell while the user types.
    const stopPreload = effect(() => {
      const state = auth.authState.value;
      if (state !== 'loading' && state !== 'signed_out') preloadShell().catch(() => undefined);
    });
    return () => {
      stopCleanup();
      stopPreload();
    };
  }, [auth]);
  const { AuthGate } = auth;
  return (
    <>
      <AuthGate>
        <LazyShell />
      </AuthGate>
      <Toast />
    </>
  );
}

/** Lets the browser paint / handle input between two long pieces of start-up work. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** How long the splash may stay up while the vault is read, instead of a spinner flash. */
const SPLASH_WAIT_MS = 1500;

/** Called by the entry chunk (main.tsx) once this chunk is loaded. */
export async function start(): Promise<void> {
  initMonitoring();
  // Arabic is bundled; another saved language is loaded (from the precache when offline) before the first render.
  await initI18n();
  await yieldToMain();
  // The auth stack is evaluated in several tasks instead of one long one (Total Blocking Time):
  // the two big libraries and the local database first, each on its own, then the auth module,
  // which finds them already evaluated. Same chunks, same order — only split up.
  await import('@supabase/supabase-js');
  await yieldToMain();
  await import('dexie');
  await yieldToMain();
  await import('./db');
  await yieldToMain();
  const auth = await import('./auth');
  // The vault decides between sign-in and PIN lock; while it is read (IndexedDB, normally a few
  // ms) the splash stays up rather than flashing the gate's spinner. Never longer than the cap:
  // the gate shows its own loading state for anything slower.
  await Promise.race([
    auth.initAuth().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, SPLASH_WAIT_MS)),
  ]);
  await yieldToMain();
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app element');
  root.textContent = '';
  render(<App auth={auth} />, root);
  // After the first render: registration must never delay the application.
  registerServiceWorker().catch(() => undefined);
}
