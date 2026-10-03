/** Typed access to build-time configuration. No secrets ever live here (anon key only). */
export const env = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  appName: (import.meta.env.VITE_APP_NAME as string | undefined) ?? '',
  appEnv: ((import.meta.env.VITE_APP_ENV as string | undefined) ?? 'development') as
    | 'development'
    | 'staging'
    | 'production',
  tilesUrl: (import.meta.env.VITE_TILES_URL as string | undefined) ?? '',
  sentryDsn: (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? '',
} as const;
