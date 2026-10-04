/**
 * Gate for the development-only helpers. Both operands are replaced by literals at build time,
 * so a production build (`VITE_APP_ENV=production`) contains neither the helper nor a reference
 * to its chunk. Production builds MUST set VITE_APP_ENV=production.
 */
export const DEV_AUTH_TOOLS: boolean =
  import.meta.env.DEV || import.meta.env.VITE_APP_ENV !== 'production';

export function loadDevTools(): void {
  if (import.meta.env.DEV || import.meta.env.VITE_APP_ENV !== 'production') {
    if (typeof window === 'undefined') return;
    void import('./dev').then((dev) => dev.installDevTools());
  }
}
