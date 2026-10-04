/**
 * Public API of the auth module (docs/contracts/web.md §3.6).
 * Other modules import from here only: `import { supabase, session, me, can, pin } from '../auth'`.
 */
import { loadDevTools } from './devtools';

// --- contract §3.6 -------------------------------------------------------------------------
export { supabase } from './supabase';
export { deviceId } from './device';
export {
  session,
  me,
  can,
  pin,
  signInWithEmailOtp,
  signInWithPhoneOtp,
  verifyOtp,
  signOut,
} from './session';

// --- extensions (additive) -----------------------------------------------------------------
export {
  authState,
  authNotice,
  contextError,
  lockMinutes,
  initAuth,
  refreshContext,
  accessToken,
  handleSessionProblem,
  handleSessionRevoked,
  setAuthPorts,
  type AuthState,
  type AuthNotice,
  type AuthPorts,
  type ResetReason,
  type SessionProblem,
} from './session';
export { AuthGate } from './AuthGate';
export { AuthFlowError, isSessionRevokedError, type AuthErrorKind } from './errors';
export type { MyContext, RoleGrant, RoleName, ScopeTriple, Aal, Capabilities } from './context';
export type { PinAttempts, UnlockResult } from './vault';
export { DIAL_COUNTRIES, toE164, isE164 } from './phone';

loadDevTools();
