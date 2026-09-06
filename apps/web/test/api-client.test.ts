import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../src/lib/api-client.js';
import { ApiError } from '../src/lib/api-error.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api client', () => {
  it('prefixes the configured base URL and parses a JSON success body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      fetchImpl,
    });

    await expect(client.get('/api/monitors')).resolves.toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/monitors');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('sends a bearer token when one is available, and none when it is not', async () => {
    let token: string | null = null;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const client = createApiClient({ fetchImpl, getToken: () => token });

    await client.get('/api/auth/me');
    const anonymous = headersOf(fetchImpl, 0);
    expect(anonymous.get('Authorization')).toBeNull();

    token = 'token-abc';
    await client.get('/api/auth/me');
    expect(headersOf(fetchImpl, 1).get('Authorization')).toBe(
      'Bearer token-abc',
    );
  });

  it('serialises JSON bodies for post, patch and delete', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const client = createApiClient({ fetchImpl });

    await client.post('/api/monitors', { name: 'a' });
    await client.patch('/api/monitors/1', { name: 'b' });
    await client.delete('/api/monitors/1');

    const calls = fetchImpl.mock.calls as [string, RequestInit][];
    expect(calls.map(([, init]) => init.method)).toEqual([
      'POST',
      'PATCH',
      'DELETE',
    ]);
    expect(calls[0]?.[1].body).toBe('{"name":"a"}');
    expect(calls[1]?.[1].body).toBe('{"name":"b"}');
    expect(calls[2]?.[1].body).toBeUndefined();
    expect(headersOf(fetchImpl, 0).get('Content-Type')).toBe(
      'application/json',
    );
  });

  it('turns the API error envelope into a typed ApiError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        error: { code: 'validation_failed', message: 'url must be http(s)' },
      }),
    );
    const client = createApiClient({ fetchImpl });

    const error = await client
      .post('/api/monitors', {})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'validation_failed',
      message: 'url must be http(s)',
    });
  });

  it('flags a 401 so the session layer can react to it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        error: { code: 'unauthenticated', message: 'Authentication required' },
      }),
    );
    const client = createApiClient({ fetchImpl });

    const error = (await client
      .get('/api/auth/me')
      .catch((e: unknown) => e)) as ApiError;

    expect(error.isUnauthenticated).toBe(true);
  });

  it('never forwards a server-side message to the user', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(500, {
        error: {
          code: 'internal_error',
          message: 'ECONNREFUSED 10.0.0.4:5432',
        },
      }),
    );
    const client = createApiClient({ fetchImpl });

    const error = (await client
      .get('/api/monitors')
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('internal_error');
    expect(error.message).not.toContain('10.0.0.4');
  });

  it('reports an unrecognised body generically instead of echoing it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      );
    const client = createApiClient({ fetchImpl });

    const error = (await client
      .get('/api/monitors')
      .catch((e: unknown) => e)) as ApiError;

    expect(error.status).toBe(502);
    expect(error.message).not.toContain('html');
  });

  it('represents a transport failure as a network ApiError', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch'));
    const client = createApiClient({ fetchImpl });

    const error = (await client
      .get('/api/monitors')
      .catch((e: unknown) => e)) as ApiError;

    expect(error.isNetworkError).toBe(true);
    expect(error.code).toBe('network_error');
  });

  it('resolves a 204 without trying to parse a body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = createApiClient({ fetchImpl });

    await expect(client.delete('/api/monitors/1')).resolves.toBeUndefined();
  });
});

function headersOf(fetchImpl: ReturnType<typeof vi.fn>, call: number): Headers {
  const [, init] = fetchImpl.mock.calls[call] as [string, RequestInit];
  return new Headers(init.headers);
}
