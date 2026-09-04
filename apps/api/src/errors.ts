/**
 * An error that is safe to expose to API clients.
 *
 * `code` is a stable machine-readable identifier so the frontend can branch on
 * it without matching human-readable message text.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'not_found', message);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed') {
    super(400, 'validation_failed', message);
  }
}

/**
 * No usable credentials were presented (missing, malformed or expired token).
 *
 * The message is deliberately uninformative: telling a caller *why* a token
 * failed ("expired at ...", "bad signature") hands an attacker a free oracle
 * for probing token forgery. The frontend branches on `code`, not on prose.
 */
export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'unauthenticated', message);
  }
}

/**
 * Login failed.
 *
 * One error for both "no such account" and "wrong password" — a distinct
 * message for each turns the login endpoint into a free account-existence
 * oracle for credential stuffing.
 */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super(401, 'invalid_credentials', 'Invalid email or password');
  }
}

/** The request conflicts with the current state of the resource. */
export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}
