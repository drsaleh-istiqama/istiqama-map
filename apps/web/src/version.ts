declare const __APP_VERSION__: string;

/** Injected at build time from the root package.json — the only place the version is written. */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';
