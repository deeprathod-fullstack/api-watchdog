import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import { AppRoutes } from '../src/app/AppRoutes.js';
import { AuthProvider } from '../src/features/auth/AuthProvider.js';
import { tokenStorage } from '../src/lib/api.js';
import { createApiClient } from '../src/lib/api-client.js';
import { createMemoryTokenStorage } from '../src/lib/token-storage.js';

export const USER = {
  id: 'u1',
  name: 'Deep Rathod',
  email: 'deep@example.com',
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** A monitor as the API returns it. */
export function monitorFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Checkout API',
    url: 'https://api.example.com/health',
    method: 'GET',
    expectedStatus: 200,
    intervalSeconds: 300,
    timeoutMs: 5000,
    headers: {},
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * An empty dashboard payload.
 *
 * Every authenticated landing on `/` issues one dashboard request, so tests
 * that pass through the dashboard on their way somewhere else queue this to
 * satisfy it without saying anything about dashboard behaviour.
 */
export function dashboardResponse(
  summary: Partial<Record<string, number>> = {},
  monitors: unknown[] = [],
): Response {
  return jsonResponse(200, {
    summary: {
      total: 0,
      active: 0,
      healthy: 0,
      failing: 0,
      unknown: 0,
      openIncidents: 0,
      ...summary,
    },
    monitors,
  });
}

export function errorResponse(status: number, code: string, message: string) {
  return jsonResponse(status, { error: { code, message } });
}

/**
 * A queue-backed fake API.
 *
 * Each call takes the next queued response, so a test states the sequence the
 * server would produce and nothing else. Tests assert on the recorded requests
 * rather than on how the client was called internally.
 */
/** A queue entry: a response, a rejection, or a promise that may never settle. */
export type FakeResponse = Response | Error | Promise<Response>;

export function createFakeApi(responses: FakeResponse[] = []) {
  const queue = [...responses];

  const fetchImpl = vi.fn((url: string, _init: RequestInit) => {
    const next = queue.shift();

    if (next instanceof Error) return Promise.reject(next);
    if (!next) throw new Error(`Unexpected request to ${url}`);

    return Promise.resolve(next);
  });

  return {
    fetchImpl,
    /** Queue another response, for a second request within one test. */
    enqueue: (response: FakeResponse) => {
      queue.push(response);
    },
    /**
     * A function, not a getter: the render helper spreads this object, and a
     * getter would be evaluated once at spread time and freeze an empty list.
     */
    getRequests: () =>
      fetchImpl.mock.calls.map(([url, init]) => ({
        url,
        method: init.method,
        headers: new Headers(init.headers),
        body:
          typeof init.body === 'string'
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined,
      })),
  };
}

export interface RenderAppOptions {
  path?: string;
  token?: string;
  responses?: FakeResponse[];
}

/**
 * Render the real route table under the real provider, with only the network
 * and the token store faked. Tests then drive the app the way a person does.
 */
export function renderApp({
  path = '/',
  token,
  responses = [],
}: RenderAppOptions = {}) {
  const storage = createMemoryTokenStorage();
  if (token) storage.set(token);

  const fake = createFakeApi(responses);

  // Feature modules use the application's own `api` singleton rather than an
  // injected client, so the fake has to stand in for the global `fetch` too.
  // The singleton reads its token from the real storage, so that is seeded to
  // match; `setup.ts` clears both after every test.
  vi.stubGlobal('fetch', fake.fetchImpl);
  tokenStorage.clear();
  if (token) tokenStorage.set(token);

  let expire: (() => void) | null = null;
  const onSessionExpired = (handler: () => void) => {
    expire = handler;
    return () => {
      expire = null;
    };
  };

  const client = createApiClient({
    fetchImpl: fake.fetchImpl as unknown as typeof fetch,
    getToken: () => storage.get(),
    onUnauthenticated: () => expire?.(),
  });

  const view = render(
    <AuthProvider
      client={client}
      storage={storage}
      onSessionExpired={onSessionExpired}
    >
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );

  return { ...view, ...fake, storage, client };
}
