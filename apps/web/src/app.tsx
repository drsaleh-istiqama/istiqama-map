import { useEffect } from 'preact/hooks';
import { AuthGate, authState } from './auth';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Shell } from './ui/shell/Shell';
import { clearUserTraces, watchSignedOut } from './ui/shell/signOutCleanup';
import { Toast } from './ui/Toast';

/**
 * Root component. `AuthGate` (auth team) decides between sign-in, MFA, the PIN lock and the
 * application; the shell renders only for a signed-in, unlocked user. Toasts and the confirm
 * dialog live outside the gate so the sign-in screens can use them too.
 */
export function App() {
  // However the session ended, the next person on this device sees nothing of the last one.
  useEffect(() => watchSignedOut(authState, clearUserTraces), []);
  return (
    <>
      <AuthGate>
        <Shell />
      </AuthGate>
      <Toast />
      <ConfirmDialog />
    </>
  );
}
