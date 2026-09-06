import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  USER,
  errorResponse,
  jsonResponse,
  monitorFixture,
  renderApp,
  type FakeResponse,
} from './helpers.js';

const MONITOR_ID = '11111111-1111-4111-8111-111111111111';
const HISTORY_PATH = `/monitors/${MONITOR_ID}/history`;

function check(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    monitorId: MONITOR_ID,
    status: 'success',
    httpStatus: 200,
    responseTimeMs: 143,
    errorType: null,
    errorMessage: null,
    checkedAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    monitorId: MONITOR_ID,
    status: 'resolved',
    startedAt: '2026-01-01T09:00:00.000Z',
    resolvedAt: '2026-01-01T09:30:00.000Z',
    failureCount: 3,
    ...overrides,
  };
}

function checksPage(items: unknown[], limit = 25, offset = 0) {
  return jsonResponse(200, { checks: items, limit, offset });
}

function incidentsPage(items: unknown[], limit = 25, offset = 0) {
  return jsonResponse(200, { incidents: items, limit, offset });
}

/**
 * Render the history page.
 *
 * Three requests in a fixed order: the session bootstrap, the monitor, then the
 * two history pages. The two history calls are issued together, so the queue
 * order between them is the order the effects run.
 */
function renderHistory({
  monitor = monitorFixture(),
  checks = checksPage([check()]),
  incidents = incidentsPage([incident()]),
  extra = [],
}: {
  monitor?: Record<string, unknown> | FakeResponse;
  checks?: FakeResponse;
  incidents?: FakeResponse;
  extra?: FakeResponse[];
} = {}) {
  const monitorResponse =
    monitor instanceof Response || monitor instanceof Error
      ? monitor
      : jsonResponse(200, { monitor });

  return renderApp({
    path: HISTORY_PATH,
    token: 'token-abc',
    responses: [
      jsonResponse(200, { user: USER }),
      monitorResponse,
      checks,
      incidents,
      ...extra,
    ],
  });
}

/**
 * The sections appear only once the monitor header has loaded, so the async
 * form is the one tests should reach for; the sync form is for re-reading a
 * section that is already on screen.
 */
async function findChecksSection(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', {
    level: 2,
    name: 'Check history',
  });
  return heading.closest('section') as HTMLElement;
}

async function findIncidentsSection(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', {
    level: 2,
    name: 'Incident history',
  });
  return heading.closest('section') as HTMLElement;
}

function checksSection(): HTMLElement {
  return screen
    .getByRole('heading', { level: 2, name: 'Check history' })
    .closest('section') as HTMLElement;
}

function incidentsSection(): HTMLElement {
  return screen
    .getByRole('heading', { level: 2, name: 'Incident history' })
    .closest('section') as HTMLElement;
}

describe('history route and monitor header', () => {
  it('loads for an authenticated user and identifies the monitor', async () => {
    renderHistory({
      monitor: monitorFixture({ active: false, expectedStatus: 201 }),
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Checkout API' }),
    ).toBeTruthy();
    expect(screen.getByText('https://api.example.com/health')).toBeTruthy();
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByText('HTTP 201')).toBeTruthy();
    expect(screen.getByText('GET')).toBeTruthy();
  });

  it('passes the monitor id from the route into every request', async () => {
    const { getRequests } = renderHistory();

    await screen.findByRole('heading', { level: 1, name: 'Checkout API' });

    const urls = getRequests().map((request) => request.url);
    expect(urls).toContain(`/api/monitors/${MONITOR_ID}`);
    expect(urls).toContain(
      `/api/monitors/${MONITOR_ID}/checks?limit=25&offset=0`,
    );
    expect(urls).toContain(
      `/api/monitors/${MONITOR_ID}/incidents?limit=25&offset=0`,
    );
  });

  it('issues exactly three requests — no per-row follow-ups', async () => {
    const { getRequests } = renderHistory({
      checks: checksPage([check({ id: 'a' }), check({ id: 'b' })]),
      incidents: incidentsPage([incident({ id: 'x' }), incident({ id: 'y' })]),
    });

    await screen.findByRole('heading', { level: 1, name: 'Checkout API' });
    await within(await findChecksSection()).findByRole('table');

    const apiCalls = getRequests().filter((request) =>
      request.url.startsWith('/api/monitors'),
    );
    expect(apiCalls).toHaveLength(3);
    expect(apiCalls.every((request) => request.method === 'GET')).toBe(true);
  });

  it('sends the bearer token and never a user id', async () => {
    const { getRequests } = renderHistory();

    await screen.findByRole('heading', { level: 1, name: 'Checkout API' });

    for (const request of getRequests().filter((r) =>
      r.url.startsWith('/api/monitors'),
    )) {
      expect(request.headers.get('Authorization')).toBe('Bearer token-abc');
      expect(request.url).not.toContain('userId');
      expect(request.body).toBeUndefined();
    }
  });

  it('sends a signed-out visitor to sign in', async () => {
    const { fetchImpl } = renderApp({ path: HISTORY_PATH });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('offers a way back to the monitor list', async () => {
    renderHistory();

    await screen.findByRole('heading', { level: 1, name: 'Checkout API' });

    expect(
      screen
        .getByRole('link', { name: 'Back to monitors' })
        .getAttribute('href'),
    ).toBe('/monitors');
  });
});

describe('check history', () => {
  it('shows a loading state before any rows', async () => {
    renderHistory({ checks: new Promise<Response>(() => undefined) });

    expect(await screen.findByText('Loading check history…')).toBeTruthy();
    expect(within(checksSection()).queryByRole('table')).toBeNull();
    expect(screen.queryByText('No checks recorded yet')).toBeNull();
  });

  it('renders a successful check with its status and response time', async () => {
    renderHistory({ checks: checksPage([check()]) });

    const table = await within(await findChecksSection()).findByRole('table');
    const row = within(table).getAllByRole('row')[1] as HTMLElement;

    expect(within(row).getByText('Success')).toBeTruthy();
    expect(within(row).getByText('200')).toBeTruthy();
    expect(within(row).getByText('143 ms')).toBeTruthy();
  });

  it('renders a status mismatch with the actual status and the message', async () => {
    renderHistory({
      checks: checksPage([
        check({
          status: 'failure',
          httpStatus: 503,
          responseTimeMs: 87,
          errorType: 'status_mismatch',
          errorMessage: 'Expected status 200, received 503',
        }),
      ]),
    });

    const table = await within(await findChecksSection()).findByRole('table');
    const row = within(table).getAllByRole('row')[1] as HTMLElement;

    expect(within(row).getByText('Failure')).toBeTruthy();
    expect(within(row).getByText('Unexpected status')).toBeTruthy();
    expect(within(row).getByText('503')).toBeTruthy();
    expect(within(row).getByText('87 ms')).toBeTruthy();
    expect(
      within(row).getByText('Expected status 200, received 503'),
    ).toBeTruthy();
  });

  it('shows a dash, not zero, when a network failure recorded no status', async () => {
    renderHistory({
      checks: checksPage([
        check({
          status: 'failure',
          httpStatus: null,
          responseTimeMs: null,
          errorType: 'timeout',
          errorMessage: 'No response within 5000 ms',
        }),
      ]),
    });

    const table = await within(await findChecksSection()).findByRole('table');
    const row = within(table).getAllByRole('row')[1] as HTMLElement;

    expect(within(row).getByText('Timed out')).toBeTruthy();
    expect(within(row).getAllByText('—')).toHaveLength(2);
    expect(within(row).queryByText('0')).toBeNull();
    expect(within(row).queryByText('0 ms')).toBeNull();
  });

  it('describes the classifier when the message column is null', async () => {
    renderHistory({
      checks: checksPage([
        check({
          status: 'failure',
          httpStatus: null,
          responseTimeMs: null,
          errorType: 'dns',
          errorMessage: null,
        }),
      ]),
    });

    const table = await within(await findChecksSection()).findByRole('table');
    const row = within(table).getAllByRole('row')[1] as HTMLElement;

    expect(within(row).getByText('DNS lookup failed')).toBeTruthy();
    expect(
      within(row).getByText('The hostname could not be resolved.'),
    ).toBeTruthy();
  });

  it('labels every classifier the backend can store', async () => {
    const types = [
      ['status_mismatch', 'Unexpected status'],
      ['timeout', 'Timed out'],
      ['dns', 'DNS lookup failed'],
      ['connection_refused', 'Connection refused'],
      ['connection_error', 'Connection error'],
      ['tls', 'TLS error'],
      ['blocked_url', 'URL blocked by policy'],
      ['blocked_address', 'Address blocked by policy'],
      ['too_many_redirects', 'Too many redirects'],
      ['invalid_response', 'Invalid response'],
      ['unknown', 'Unknown error'],
    ];

    renderHistory({
      checks: checksPage(
        types.map(([errorType], index) =>
          check({
            id: `c${String(index)}`,
            status: 'failure',
            errorType,
            errorMessage: null,
          }),
        ),
      ),
    });

    const table = await within(await findChecksSection()).findByRole('table');
    for (const [, label] of types) {
      expect(within(table).getByText(label as string)).toBeTruthy();
    }
  });

  it('shows an empty state when nothing has been checked', async () => {
    renderHistory({ checks: checksPage([]) });

    expect(await screen.findByText('No checks recorded yet')).toBeTruthy();
    expect(within(checksSection()).queryByRole('table')).toBeNull();
  });

  it('reports a failed load and retries it', async () => {
    const { enqueue } = renderHistory({
      checks: errorResponse(
        500,
        'internal_error',
        'ECONNREFUSED 10.0.0.4:5432',
      ),
    });

    const section = await findChecksSection();
    const alert = within(section).getByRole('alert');
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.textContent).not.toContain('10.0.0.4');

    enqueue(checksPage([check()]));
    fireEvent.click(
      within(section).getByRole('button', { name: /try again/i }),
    );

    expect(
      await within(await findChecksSection()).findByRole('table'),
    ).toBeTruthy();
  });

  it('reports an unreachable API in plain language', async () => {
    renderHistory({ checks: new TypeError('Failed to fetch') });

    const section = await findChecksSection();
    await waitFor(() => {
      expect(within(section).getByRole('alert').textContent).toContain(
        'Unable to reach API Watchdog',
      );
    });
  });
});

describe('incident history', () => {
  it('distinguishes an open incident from a resolved one', async () => {
    renderHistory({
      incidents: incidentsPage([
        incident({
          id: 'open',
          status: 'open',
          resolvedAt: null,
          failureCount: 5,
        }),
        incident({ id: 'done', status: 'resolved' }),
      ]),
    });

    const table = await within(await findIncidentsSection()).findByRole(
      'table',
    );
    const rows = within(table).getAllByRole('row');

    const openRow = rows[1] as HTMLElement;
    expect(within(openRow).getByText('Open')).toBeTruthy();
    // No resolution time yet — a dash, not a fabricated one.
    expect(within(openRow).getByText('—')).toBeTruthy();
    // The backend's own count, not a derived one.
    expect(within(openRow).getByText('5')).toBeTruthy();

    const resolvedRow = rows[2] as HTMLElement;
    expect(within(resolvedRow).getByText('Resolved')).toBeTruthy();
    expect(within(resolvedRow).queryByText('—')).toBeNull();
  });

  /**
   * Open-ness comes from `status`, which the backend states explicitly — not
   * from a missing `resolvedAt`.
   */
  it('trusts the status field over the resolved timestamp', async () => {
    renderHistory({
      incidents: incidentsPage([
        incident({ status: 'resolved', resolvedAt: null }),
      ]),
    });

    const table = await within(await findIncidentsSection()).findByRole(
      'table',
    );
    // Scoped to the badge: "Resolved" is also a column header.
    expect(
      within(table).getByText('Resolved', { selector: '.badge' }),
    ).toBeTruthy();
    expect(
      within(table).queryByText('Open', { selector: '.badge' }),
    ).toBeNull();
  });

  it('offers no controls to open, close or resolve an incident', async () => {
    renderHistory({
      incidents: incidentsPage([
        incident({ status: 'open', resolvedAt: null }),
      ]),
    });

    await within(await findIncidentsSection()).findByRole('table');
    const section = incidentsSection();

    expect(
      within(section).queryByRole('button', { name: /resolve/i }),
    ).toBeNull();
    expect(
      within(section).queryByRole('button', { name: /close/i }),
    ).toBeNull();
    expect(
      within(section).queryByRole('button', { name: /delete/i }),
    ).toBeNull();
  });

  it('shows no duration column, since the API reports none', async () => {
    renderHistory();

    const table = await within(await findIncidentsSection()).findByRole(
      'table',
    );
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);

    expect(headers).toEqual([
      'Status',
      'Started',
      'Resolved',
      'Consecutive failures',
    ]);
  });

  it('shows an empty state when there are no incidents', async () => {
    renderHistory({ incidents: incidentsPage([]) });

    expect(await screen.findByText('No incidents recorded')).toBeTruthy();
  });

  it('fails independently of the check history', async () => {
    renderHistory({
      checks: checksPage([check()]),
      incidents: errorResponse(500, 'internal_error', 'boom'),
    });

    // Checks still render.
    expect(
      await within(await findChecksSection()).findByRole('table'),
    ).toBeTruthy();
    // Incidents show their own error, not an empty state.
    const incidentSection = await findIncidentsSection();
    await waitFor(() => {
      expect(within(incidentSection).getByRole('alert').textContent).toContain(
        'Something went wrong',
      );
    });
    expect(screen.queryByText('No incidents recorded')).toBeNull();
  });
});

describe('monitor access failures', () => {
  it('reports a monitor that is missing or not yours, without saying which', async () => {
    renderHistory({
      monitor: errorResponse(404, 'not_found', 'Monitor not found'),
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('no longer exists');
    // Nothing that would confirm another account's monitor exists.
    expect(alert.textContent).not.toContain('forbidden');
    expect(alert.textContent).not.toContain('permission');
    // No history sections are rendered at all. (The page's own <h1> still
    // reads "Check history", so this asks for the section heading.)
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Check history' }),
    ).toBeNull();
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Incident history' }),
    ).toBeNull();
  });

  it('never shows a server-side 500 message', async () => {
    renderHistory({
      monitor: errorResponse(
        500,
        'internal_error',
        'ECONNREFUSED 10.0.0.4:5432',
      ),
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.textContent).not.toContain('10.0.0.4');
  });

  it('reports an unreachable API when the monitor cannot be loaded', async () => {
    renderHistory({ monitor: new TypeError('Failed to fetch') });

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Unable to reach API Watchdog',
    );
  });
});

describe('pagination', () => {
  const fullPage = Array.from({ length: 25 }, (_, index) =>
    check({ id: `c${String(index)}` }),
  );

  it('is hidden when a single short page is all there is', async () => {
    renderHistory({ checks: checksPage([check()]) });

    await within(await findChecksSection()).findByRole('table');
    expect(
      within(checksSection()).queryByRole('button', { name: /next page/i }),
    ).toBeNull();
  });

  it('offers Next on a full page and fetches the next offset', async () => {
    const { getRequests } = renderHistory({
      checks: checksPage(fullPage),
      extra: [checksPage([check({ id: 'page2' })], 25, 25)],
    });

    const section = await findChecksSection();
    expect(await within(section).findByText('Showing 1–25')).toBeTruthy();

    fireEvent.click(
      within(section).getByRole('button', { name: /next page/i }),
    );

    await waitFor(() => {
      expect(within(checksSection()).getByText('Showing 26–26')).toBeTruthy();
    });

    expect(getRequests().map((r) => r.url)).toContain(
      `/api/monitors/${MONITOR_ID}/checks?limit=25&offset=25`,
    );
  });

  it('disables Previous on the first page and enables it after Next', async () => {
    renderHistory({
      checks: checksPage(fullPage),
      extra: [checksPage([check({ id: 'page2' })], 25, 25)],
    });

    const section = await findChecksSection();
    const previous = await within(section).findByRole('button', {
      name: /previous page/i,
    });
    expect(previous.hasAttribute('disabled')).toBe(true);

    fireEvent.click(
      within(section).getByRole('button', { name: /next page/i }),
    );

    await waitFor(() => {
      expect(
        within(checksSection())
          .getByRole('button', { name: /previous page/i })
          .hasAttribute('disabled'),
      ).toBe(false);
    });
  });

  it('sends one request however fast Next is clicked', async () => {
    const { getRequests } = renderHistory({
      checks: checksPage(fullPage),
      extra: [checksPage([check({ id: 'page2' })], 25, 25)],
    });

    const section = await findChecksSection();
    const next = await within(section).findByRole('button', {
      name: /next page/i,
    });

    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);

    await waitFor(() => {
      expect(within(checksSection()).getByText('Showing 26–26')).toBeTruthy();
    });

    const pageRequests = getRequests().filter((request) =>
      request.url.includes('/checks?'),
    );
    // The first page and exactly one second page.
    expect(pageRequests).toHaveLength(2);
  });
});

describe('refresh', () => {
  it('reloads both sections', async () => {
    const { getRequests } = renderHistory({
      checks: checksPage([check({ errorMessage: null })]),
      incidents: incidentsPage([]),
      extra: [
        checksPage([check({ id: 'fresh', httpStatus: 201 })]),
        incidentsPage([incident({ id: 'fresh' })]),
      ],
    });

    await within(await findChecksSection()).findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(within(checksSection()).getByText('201')).toBeTruthy();
    });
    expect(
      await within(await findIncidentsSection()).findByRole('table'),
    ).toBeTruthy();

    expect(
      getRequests().filter((request) => request.url.includes('/checks?')),
    ).toHaveLength(2);
    expect(
      getRequests().filter((request) => request.url.includes('/incidents?')),
    ).toHaveLength(2);
  });
});

describe('history is safe to render', () => {
  it('renders a hostile monitor name and error message as text', async () => {
    const hostile = '<img src=x onerror="alert(1)">';

    renderHistory({
      monitor: monitorFixture({ name: hostile }),
      checks: checksPage([
        check({
          status: 'failure',
          errorType: 'unknown',
          errorMessage: hostile,
        }),
      ]),
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: hostile }),
    ).toBeTruthy();
    const table = await within(await findChecksSection()).findByRole('table');
    expect(within(table).getByText(hostile)).toBeTruthy();
    // Escaped, not parsed into an element.
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders nothing from a body, header or token field it does not know', async () => {
    renderHistory({
      checks: checksPage([
        {
          ...check(),
          // Fields the contract does not define must simply be ignored.
          responseBody: '{"secret":"leaked"}',
          requestHeaders: { Authorization: 'Bearer eyJhbGciOi' },
        },
      ]),
    });

    await within(await findChecksSection()).findByRole('table');

    expect(document.body.textContent).not.toContain('leaked');
    expect(document.body.textContent).not.toContain('Bearer');
    expect(document.body.textContent).not.toContain('eyJhbGciOi');
  });
});
