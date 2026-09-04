import type pg from 'pg';

/** A `users` row as PostgreSQL returns it, hash included. Never leaves here. */
interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

/** A user as the rest of the application sees it. */
export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

/** A user plus the stored hash, for the login path only. */
export interface UserWithHash extends User {
  passwordHash: string;
}

/** Raised when the email is already taken, detected by the unique index. */
export class EmailAlreadyExistsError extends Error {
  override readonly name = 'EmailAlreadyExistsError';
}

/** PostgreSQL SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';

function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
  };
}

/**
 * Insert a user, or fail if the email is taken.
 *
 * Uniqueness is enforced by `users_email_lower_key` and only translated here.
 * A "SELECT then INSERT" pre-check would be a race: two simultaneous
 * registrations both see the email as free, and one of them crashes with an
 * unhandled constraint error. The constraint is the single authority that
 * cannot race, so the application's job is to interpret its failure.
 */
export async function insertUser(
  db: pg.Pool,
  input: { name: string; email: string; passwordHash: string },
): Promise<User> {
  try {
    const result = await db.query<UserRow>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, password_hash, created_at`,
      [input.name, input.email, input.passwordHash],
    );

    const row = result.rows[0];
    if (!row) throw new Error('INSERT ... RETURNING produced no row');

    return toUser(row);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === UNIQUE_VIOLATION
    ) {
      throw new EmailAlreadyExistsError('Email already registered');
    }
    throw error;
  }
}

/**
 * Look up a user for login, including the password hash.
 *
 * `lower(email)` matches the expression the unique index is built on, so this
 * lookup uses that index instead of scanning the table.
 */
export async function findUserByEmail(
  db: pg.Pool,
  email: string,
): Promise<UserWithHash | null> {
  const result = await db.query<UserRow>(
    `SELECT id, name, email, password_hash, created_at
       FROM users
      WHERE lower(email) = lower($1)`,
    [email],
  );

  const row = result.rows[0];
  return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
}

/**
 * Load a user by id for an authenticated request.
 *
 * The hash is not selected: nothing on the request path needs it, and a column
 * that is never fetched cannot leak through a response.
 */
export async function findUserById(
  db: pg.Pool,
  id: string,
): Promise<User | null> {
  const result = await db.query<Omit<UserRow, 'password_hash'>>(
    `SELECT id, name, email, created_at FROM users WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? toUser({ ...row, password_hash: '' }) : null;
}
