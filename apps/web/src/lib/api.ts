import { createApiClient } from './api-client.js';
import { createTokenStorage } from './token-storage.js';

/**
 * The application's wiring of the two pieces above.
 *
 * Feature modules import `api` and stay ignorant of where the token lives; the
 * auth provider imports `tokenStorage` and is the only thing that writes it.
 * Tests build their own client instead of importing these.
 */
export const tokenStorage = createTokenStorage();

export const api = createApiClient({ getToken: () => tokenStorage.get() });
