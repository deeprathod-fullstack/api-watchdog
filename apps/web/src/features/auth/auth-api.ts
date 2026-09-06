import type { ApiClient } from '../../lib/api-client.js';
import type {
  AuthResult,
  LoginCredentials,
  RegisterCredentials,
  User,
} from './types.js';

/**
 * The auth endpoints, typed.
 *
 * Thin on purpose: these functions map a call onto the API contract and do
 * nothing else. Storing the token and updating React state is the provider's
 * job, so this module stays usable from a test without a component tree.
 */
export function login(
  client: ApiClient,
  credentials: LoginCredentials,
): Promise<AuthResult> {
  return client.post<AuthResult>('/api/auth/login', credentials);
}

export function register(
  client: ApiClient,
  credentials: RegisterCredentials,
): Promise<AuthResult> {
  return client.post<AuthResult>('/api/auth/register', credentials);
}

export function fetchCurrentUser(
  client: ApiClient,
  options?: { token?: string; signal?: AbortSignal },
): Promise<{ user: User }> {
  return client.get<{ user: User }>('/api/auth/me', options);
}
