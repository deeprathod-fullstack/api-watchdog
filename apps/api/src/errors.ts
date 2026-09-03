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
