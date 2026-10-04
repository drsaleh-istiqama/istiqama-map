import { AuthGate } from './auth';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Shell } from './ui/shell/Shell';
import { Toast } from './ui/Toast';

/**
 * Root component. `AuthGate` (auth team) decides between sign-in, MFA, the PIN lock and the
 * application; the shell renders only for a signed-in, unlocked user. Toasts and the confirm
 * dialog live outside the gate so the sign-in screens can use them too.
 */
export function App() {
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
