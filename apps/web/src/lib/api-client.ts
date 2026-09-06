import { ApiError, toApiError } from './api-error.js';
import { env } from './env.js';

/**
 * The one place in the frontend that performs HTTP.
 *
 * It knows about transport concerns only — base URL, JSON encoding, the bearer
 * header, turning failures into {@link ApiError} — and nothing about monitors,
 * incidents or any other feature. Features build their own thin modules on top
 * (`auth-api.ts` is the first), so no component ever calls `fetch` directly and
 * error handling cannot drift between screens.
 */
export interface ApiClient {
  get: <T>(path: string, options?: RequestOptions) => Promise<T>;
  post: <T>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ) => Promise<T>;
  patch: <T>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ) => Promise<T>;
  delete: <T>(path: string, options?: RequestOptions) => Promise<T>;
}

export interface RequestOptions {
  /** Lets a caller cancel in-flight work, e.g. on unmount. */
  signal?: AbortSignal;
  /**
   * Overrides the stored token for this call. Used during login bootstrap,
   * where the token exists but has not been committed to storage yet.
   */
  token?: string | null;
}

export interface ApiClientOptions {
  baseUrl?: string;
  /**
   * Supplies the bearer token per request rather than capturing one at
   * construction, so a login or logout takes effect on the very next call.
   */
  getToken?: () => string | null;
  fetchImpl?: typeof fetch;
  /**
   * Called when an *authenticated* request comes back 401.
   *
   * The token the app is holding has expired or been rejected, and every
   * screen would otherwise discover that separately. One notification lets the
   * session layer clear itself once, from anywhere in the app.
   *
   * Requests sent without a token never trigger it: a failed sign-in is also a
   * 401, and treating it as an expiring session would be nonsense.
   */
  onUnauthenticated?: () => void;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? env.apiBaseUrl;
  const getToken = options.getToken ?? (() => null);
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const onUnauthenticated = options.onUnauthenticated;

  async function request<T>(
    method: string,
    path: string,
    body: unknown,
    requestOptions: RequestOptions = {},
  ): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' });

    const token =
      requestOptions.token !== undefined ? requestOptions.token : getToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const hasBody = body !== undefined;
    if (hasBody) {
      headers.set('Content-Type', 'application/json');
    }

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: hasBody ? JSON.stringify(body) : undefined,
        signal: requestOptions.signal,
      });
    } catch (cause) {
      // No response at all: offline, DNS failure, blocked by CORS, or aborted.
      // Deliberately not logged — the request carries an Authorization header,
      // and console output is the easiest place for a token to escape into a
      // browser-extension log or an error-reporting integration.
      throw new ApiError(
        0,
        'network_error',
        'Could not reach the server. Check your connection and try again.',
        { cause },
      );
    }

    const payload = await readJson(response);

    if (!response.ok) {
      if (response.status === 401 && token) {
        onUnauthenticated?.();
      }
      throw toApiError(response.status, payload);
    }

    return payload as T;
  }

  return {
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body, opts) => request('POST', path, body, opts),
    patch: (path, body, opts) => request('PATCH', path, body, opts),
    delete: (path, opts) => request('DELETE', path, undefined, opts),
  };
}

/**
 * Read a JSON body, tolerating the bodyless ones.
 *
 * A 204 and an error page from a proxy both fail `response.json()`. Returning
 * `undefined` lets the success path type it as `void` and lets the error path
 * fall back to a generic message instead of throwing a parse error that hides
 * the real status.
 */
async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;

  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}
