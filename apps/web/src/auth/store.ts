/** The one vault of the application (see vault.ts for the design and the threat model). */
import { Vault } from './vault';

/** supabase-js `storageKey`: name of the session item inside the vault. */
export const STORAGE_KEY = 'istiqama-auth';

export const vault = new Vault({ sessionKey: STORAGE_KEY });
