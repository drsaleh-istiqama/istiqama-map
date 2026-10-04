/**
 * Network guards around the Auth API.
 *
 * Field phones regularly sit behind captive portals and broken proxies that answer ANY request
 * with an HTML page. supabase-js treats an unparseable answer to a token refresh as a final
 * refusal and deletes the session — which would sign a collector out in the middle of nowhere,
 * with no way to sign in again. GoTrue always answers JSON, so an Auth response that is not JSON
 * did not come from our server: it is turned into a network failure (retryable, session kept).
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function createGuardedFetch(supabaseUrl: string, baseFetch?: FetchLike): FetchLike {
  const authPrefix = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/`;
  return async (input, init) => {
    const doFetch = baseFetch ?? globalThis.fetch.bind(globalThis);
    const response = await doFetch(input, init);
    if (!urlOf(input).startsWith(authPrefix)) return response;
    if (response.status === 204 || response.status === 205) return response;
    const contentType = response.headers.get('content-type') ?? '';
    if (!/\bjson\b/i.test(contentType)) {
      throw new TypeError('Failed to fetch: unexpected non-JSON answer from the auth endpoint');
    }
    return response;
  };
}

/**
 * Does the address the app was opened with carry a sign-in callback (magic link)?
 * Implicit flow: `#access_token=…&refresh_token=…`; errors come back as `error_description`.
 */
export function urlHasAuthCallback(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  if (fragment.has('access_token') || fragment.has('error_description')) return true;
  return url.searchParams.has('error_description');
}
