import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  USER,
  errorResponse,
  jsonResponse,
  monitorFixture as monitor,
  renderApp,
} from './helpers.js';

const VALID = {
  name: 'Checkout API',
  url: 'https://api.example.com/health',
};

function fillIn(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function renderNew(responses: (Response | Error)[] = []) {
  return renderApp({
    path: '/monitors/new',
    token: 'token-abc',
    responses: [jsonResponse(200, { user: USER }), ...responses],
  });
}

function renderEdit(responses: (Response | Error)[]) {
  return renderApp({
    path: '/monitors/11111111-1111-4111-8111-111111111111/edit',
    token: 'token-abc',
    responses: [jsonResponse(200, { user: USER }), ...responses],
  });
}

function submitCreate() {
  fireEvent.click(screen.getByRole('button', { name: 'Create monitor' }));
}

describe('create monitor', () => {
  it('renders the form with GET stated rather than offered as a choice', async () => {
    renderNew();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'New monitor' }),
    ).toBeTruthy();

    const method = screen.getByLabelText(/method/i);
    expect(method).toHaveProperty('value', 'GET');
    // Read-only rather than disabled: a disabled input is skipped by the
    // keyboard and by most screen readers, which would hide the one field
    // that explains the V1 constraint.
    expect(method).toHaveProperty('readOnly', true);
    expect(method).toHaveProperty('disabled', false);

    // Defaults that match the backend's own.
    expect(screen.getByLabelText(/expected status/i)).toHaveProperty(
      'value',
      '200',
    );
  });

  it('requires a name and a URL before calling the API', async () => {
    const { fetchImpl } = renderNew();

    await screen.findByRole('heading', { name: 'New monitor' });
    fillIn(/^name$/i, '   ');
    fillIn(/^url$/i, '');
    submitCreate();

    expect(await screen.findByText('Name is required.')).toBeTruthy();
    expect(screen.getByText('URL is required.')).toBeTruthy();
    // Only the session bootstrap has been requested.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed URL', async () => {
    const { fetchImpl } = renderNew();

    await screen.findByRole('heading', { name: 'New monitor' });
    fillIn(/^name$/i, VALID.name);
    fillIn(/^url$/i, 'not a url');
    submitCreate();

    expect(
      await screen.findByText(/enter a valid url, including http/i),
    ).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-http scheme', async () => {
    renderNew();

    await screen.findByRole('heading', { name: 'New monitor' });
    fillIn(/^name$/i, VALID.name);
    fillIn(/^url$/i, 'ftp://files.example.com/health');
    submitCreate();

    expect(
      await screen.findByText('URL must start with http:// or https://'),
    ).toBeTruthy();
  });

  it('rejects credentials embedded in the URL', async () => {
    renderNew();

    await screen.findByRole('heading', { name: 'New monitor' });
    fillIn(/^name$/i, VALID.name);
    fillIn(/^url$/i, 'https://user:secret@api.example.com/health');
    submitCreate();

    expect(
      await screen.findByText('URL must not contain a username or password.'),
    ).toBeTruthy();
  });

  it('rejects a non-default port, matching backend policy', async () => {
    renderNew();

    await screen.findByRole('heading', { name: 'New monitor' });
    fillIn(/^name$/i, VALID.name);
    fillIn(/^url$/i, 'https://api.example.com:8443/health');
    submitCreate();

    expect(await screen.findByText(/must use port 80 for http/i)).toBeTruthy();
  });

  it('rejects numeric values outside the supported ranges', async () => {
    renderNew();

    await screen.findByRole('heading', { name: 'New monitor' });
    fillIn(/^name$/i, VALID.name);
    fillIn(/^url$/i, VALID.url);
    fillIn(/expected status/i, '99');
    fillIn(/check interval/i, '0');
    fillIn(/timeout/i, '999');
    submitCreate();

    expect(
      await screen.findByText(/expected status must be between 100 and 599/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/check interval must be between 1 and 86400 seconds/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/timeout must be between 1000 and 30000/i),
    ).toBeTruthy();
  });

  it('rejects a timeout longer than the interval', async () => {
    renderNew();

    await screen.findByRole('heading', { name: 'New monitor' });
    fillIn(/^name$/i, VALID.name);
    fillIn(/^url$/i, VALID.url);
    fillIn(/check interval/i, '2');
    fillIn(/timeout/i, '5000');
    submitCreate();

    expect(
      await screen.findByText(
        'Timeout must not be longer than the check interval.',
      ),
    ).toBeTruthy();
  });

  it('creates the monitor and returns to the list', async () => {
    const { getRequests } = renderNew([
      jsonResponse(201, { monitor: monitor() }),
      jsonResponse(200, { monitors: [monitor()] }),
    ]);

    await screen.findByRole('heading', { name: 'New monitor' });
    fillIn(/^name$/i, `  ${VALID.name}  `);
    fillIn(/^url$/i, VALID.url);
    submitCreate();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Monitors' }),
    ).toBeTruthy();

    const create = getRequests()[1];
    expect(create?.method).toBe('POST');
    expect(create?.url).toBe('/api/monitors');
    expect(create?.body).toEqual({
      name: VALID.name,
      url: VALID.url,
      method: 'GET',
      expectedStatus: 200,
      intervalSeconds: 300,
      timeoutMs: 5000,
      headers: {},
    });
    // Ownership is never asserted by the client.
    expect(create?.body).not.toHaveProperty('userId');
  });

  it('shows the backend validation message and stays on the form', async () => {
    renderNew([
      errorResponse(
        400,
        'validation_failed',
        'url must not point at a blocked IP address',
      ),
    ]);

    await screen.findByRole('heading', { name: 'New monitor' });
    fillIn(/^name$/i, VALID.name);
    fillIn(/^url$/i, 'http://internal.example.com/health');
    submitCreate();

    expect((await screen.findByRole('alert')).textContent).toContain(
      'must not point at a blocked IP address',
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'New monitor' }),
    ).toBeTruthy();
    // The form is usable again.
    expect(screen.getByRole('button', { name: 'Create monitor' })).toBeTruthy();
  });

  it('explains the monitor limit', async () => {
    renderNew([
      errorResponse(409, 'monitor_limit_reached', 'A user may own at most 20'),
    ]);

    await screen.findByRole('heading', { name: 'New monitor' });
    fillIn(/^name$/i, VALID.name);
    fillIn(/^url$/i, VALID.url);
    submitCreate();

    expect((await screen.findByRole('alert')).textContent).toContain(
      'maximum number of monitors',
    );
  });

  it('sends one request however fast the button is clicked', async () => {
    const { fetchImpl } = renderNew([
      jsonResponse(201, { monitor: monitor() }),
      jsonResponse(200, { monitors: [monitor()] }),
    ]);

    await screen.findByRole('heading', { name: 'New monitor' });
    fillIn(/^name$/i, VALID.name);
    fillIn(/^url$/i, VALID.url);

    const button = screen.getByRole('button', { name: 'Create monitor' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await screen.findByRole('heading', { level: 1, name: 'Monitors' });
    await waitFor(() => {
      // Bootstrap, one create, one list reload.
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
  });
});

describe('header editor', () => {
  it('offers only the non-secret header names', async () => {
    renderNew();

    await screen.findByRole('heading', { name: 'New monitor' });

    const names = screen
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names).toEqual(['Accept', 'User-Agent', 'X-Environment']);
    // No way to express a credential.
    expect(names).not.toContain('Authorization');
    expect(names).not.toContain('Cookie');
  });

  it('adds, rejects duplicates, and removes', async () => {
    renderNew();

    await screen.findByRole('heading', { name: 'New monitor' });

    fillIn(/header value/i, '  application/json  ');
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));

    // Scoped to the added-header list: "Accept" is also a dropdown option.
    expect(
      await screen.findByText('Accept', { selector: '.headers__name' }),
    ).toBeTruthy();
    // Trimmed on the way in.
    expect(screen.getByText('application/json')).toBeTruthy();

    // Same name again is refused rather than silently overwriting.
    fillIn(/header value/i, 'text/plain');
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    expect(await screen.findByText(/accept is already set/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('No headers added.')).toBeTruthy();
  });

  it('refuses an empty value and one containing a control character', async () => {
    renderNew();

    await screen.findByRole('heading', { name: 'New monitor' });

    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    expect(await screen.findByText('Header value is required.')).toBeTruthy();

    // A browser strips CR and LF from an <input> value by itself, so the case
    // worth asserting is a control character it keeps: a tab.
    fillIn(/header value/i, 'a\tb');
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    expect(await screen.findByText(/printable ascii characters/i)).toBeTruthy();
  });

  it('sends the headers it collected', async () => {
    const { getRequests } = renderNew([
      jsonResponse(201, { monitor: monitor() }),
      jsonResponse(200, { monitors: [monitor()] }),
    ]);

    await screen.findByRole('heading', { name: 'New monitor' });
    fillIn(/^name$/i, VALID.name);
    fillIn(/^url$/i, VALID.url);
    fillIn(/header value/i, 'application/json');
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    submitCreate();

    await screen.findByRole('heading', { level: 1, name: 'Monitors' });
    expect(getRequests()[1]?.body).toMatchObject({
      headers: { Accept: 'application/json' },
    });
  });
});

describe('edit monitor', () => {
  it('loads the monitor and populates the form', async () => {
    renderEdit([
      jsonResponse(200, {
        monitor: monitor({
          name: 'Billing API',
          intervalSeconds: 600,
          headers: { Accept: 'application/json' },
        }),
      }),
    ]);

    expect(await screen.findByText('Loading monitor…')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByLabelText(/^name$/i)).toHaveProperty(
        'value',
        'Billing API',
      );
    });
    expect(screen.getByLabelText(/check interval/i)).toHaveProperty(
      'value',
      '600',
    );
    // Existing headers come back as removable entries.
    expect(
      screen.getByText('Accept', { selector: '.headers__name' }),
    ).toBeTruthy();
    expect(screen.getByText('application/json')).toBeTruthy();
  });

  it('reports a monitor that cannot be loaded and can retry', async () => {
    const { enqueue } = renderEdit([
      errorResponse(404, 'not_found', 'Monitor not found'),
    ]);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'no longer exists',
    );
    expect(screen.queryByLabelText(/^name$/i)).toBeNull();

    enqueue(jsonResponse(200, { monitor: monitor() }));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/^name$/i)).toHaveProperty(
        'value',
        'Checkout API',
      );
    });
  });

  it('patches the editable fields only, then returns to the list', async () => {
    const { getRequests } = renderEdit([
      jsonResponse(200, { monitor: monitor() }),
      jsonResponse(200, { monitor: monitor({ name: 'Renamed' }) }),
      jsonResponse(200, { monitors: [monitor({ name: 'Renamed' })] }),
    ]);

    await waitFor(() => {
      expect(screen.getByLabelText(/^name$/i)).toHaveProperty(
        'value',
        'Checkout API',
      );
    });

    fillIn(/^name$/i, 'Renamed');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Monitors' }),
    ).toBeTruthy();

    const patch = getRequests()[2];
    expect(patch?.method).toBe('PATCH');
    expect(patch?.body).toEqual({
      name: 'Renamed',
      url: 'https://api.example.com/health',
      expectedStatus: 200,
      intervalSeconds: 300,
      timeoutMs: 5000,
      headers: {},
    });
    // `method` is unchangeable and `active` belongs to pause/resume.
    expect(patch?.body).not.toHaveProperty('method');
    expect(patch?.body).not.toHaveProperty('active');
  });

  it('keeps the user on the form when the update fails', async () => {
    renderEdit([
      jsonResponse(200, { monitor: monitor() }),
      errorResponse(400, 'validation_failed', 'name is required'),
    ]);

    await waitFor(() => {
      expect(screen.getByLabelText(/^name$/i)).toHaveProperty(
        'value',
        'Checkout API',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'name is required',
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
  });
});

describe('monitor route access', () => {
  it('sends a signed-out visitor to sign in', async () => {
    renderApp({ path: '/monitors/new' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeTruthy();
  });

  it('routes /monitors/new to the form rather than the detail page', async () => {
    renderNew();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'New monitor' }),
    ).toBeTruthy();
  });
});
