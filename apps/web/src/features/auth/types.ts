/** A user as the API serialises it (`toPublicUser` on the backend). */
export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

/** Response body of `POST /api/auth/register` and `POST /api/auth/login`. */
export interface AuthResult {
  user: User;
  token: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterCredentials extends LoginCredentials {
  name: string;
}
