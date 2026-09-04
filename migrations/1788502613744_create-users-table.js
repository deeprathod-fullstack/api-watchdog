/**
 * Create the `users` table.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const up = (pgm) => {
  pgm.createTable('users', {
    // UUID rather than a serial integer: sequential ids leak how many users
    // exist and let anyone enumerate resources by counting upwards.
    // gen_random_uuid() is built into PostgreSQL 13+, so no extension.
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    // Display name. NOT NULL with no default: registration must supply it, so
    // we never end up rendering a dashboard for a nameless account.
    name: {
      type: 'text',
      notNull: true,
    },
    email: {
      type: 'text',
      notNull: true,
    },
    // The bcrypt/argon2 output, never the password. Sized by the algorithm, so
    // `text` avoids a pointless length guess.
    password_hash: {
      type: 'text',
      notNull: true,
    },
    // timestamptz, not timestamp: it stores an absolute instant. A naive
    // `timestamp` silently means "some local time" and breaks the moment the
    // server and the database disagree about a time zone.
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Case-insensitive uniqueness. A plain UNIQUE(email) would happily store
  // both 'Ada@example.com' and 'ada@example.com' as separate accounts, which
  // is an account-takeover and confusion hazard at login.
  //
  // This is a unique index on an expression, so it also serves the login
  // lookup `WHERE lower(email) = lower($1)` — one index, both jobs.
  pgm.createIndex('users', 'lower(email)', {
    name: 'users_email_lower_key',
    unique: true,
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const down = (pgm) => {
  // Dropping the table drops its indexes with it.
  pgm.dropTable('users');
};
