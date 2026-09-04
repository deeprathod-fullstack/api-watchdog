/**
 * Create the `monitors` table: the endpoints a user asks us to watch.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const up = (pgm) => {
  pgm.createTable(
    'monitors',
    {
      id: {
        type: 'uuid',
        primaryKey: true,
        default: pgm.func('gen_random_uuid()'),
      },
      // ON DELETE CASCADE: a monitor cannot exist without its owner. Deleting
      // a user removes their monitors in the same transaction rather than
      // leaving rows no one can reach or authorize.
      user_id: {
        type: 'uuid',
        notNull: true,
        references: 'users(id)',
        onDelete: 'CASCADE',
      },
      // NOT NULL alone would still allow the empty string.
      name: {
        type: 'text',
        notNull: true,
        check: 'char_length(name) BETWEEN 1 AND 100',
      },
      // A backstop, NOT SSRF protection. Real defence (DNS resolution,
      // private-address rejection, redirect handling) is application logic and
      // its own designed slice. This only keeps obvious nonsense — file://,
      // unbounded strings — out of the table.
      url: {
        type: 'text',
        notNull: true,
        check: "url ~ '^https?://' AND char_length(url) <= 2048",
      },
      // V1 executes GET only. The column exists for future methods (spec §9),
      // but the database should not hold a row the worker cannot execute;
      // widening this CHECK is a one-line migration when that day comes.
      method: {
        type: 'text',
        notNull: true,
        default: 'GET',
        check: "method IN ('GET')",
      },
      expected_status: {
        type: 'integer',
        notNull: true,
        default: 200,
        check: 'expected_status BETWEEN 100 AND 599',
      },
      // Positive only. A minimum interval is a real abuse control — a
      // one-second interval against a third party makes us the traffic source
      // for a denial-of-service attack — but that floor is a product policy
      // we have not set yet; it belongs with the scheduler and rate-limiting
      // design, not here.
      interval_seconds: {
        type: 'integer',
        notNull: true,
        check: 'interval_seconds > 0',
      },
      timeout_ms: {
        type: 'integer',
        notNull: true,
        check: 'timeout_ms BETWEEN 1000 AND 30000',
      },
      // jsonb, not json: stored parsed, so it is queryable and indexable
      // rather than re-parsed on every read.
      //
      // Non-secret headers only. Rejecting Authorization/Cookie/API keys is
      // enforced at the API boundary, where we can return a useful error; this
      // CHECK only guarantees the shape the code assumes, since jsonb would
      // otherwise happily store `[]`, `42`, or `"x"`.
      headers: {
        type: 'jsonb',
        notNull: true,
        default: pgm.func("'{}'::jsonb"),
        check: "jsonb_typeof(headers) = 'object'",
      },
      // Pause/resume. Paused monitors are skipped by the scheduler but keep
      // their history.
      active: {
        type: 'boolean',
        notNull: true,
        default: true,
      },
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
    },
    {
      constraints: {
        // Cross-column, so it cannot live on a single column definition: a
        // check must finish before the next one is due, otherwise checks
        // overlap and the worker queue grows without bound.
        check: 'timeout_ms <= interval_seconds * 1000',
      },
    },
  );

  // Every read is owner-scoped — listing a user's monitors, and per-resource
  // authorization on single-monitor access. PostgreSQL does not index foreign
  // keys automatically, so without this, deleting a user also sequentially
  // scans monitors to enforce the cascade.
  pgm.createIndex('monitors', 'user_id', { name: 'monitors_user_id_idx' });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const down = (pgm) => {
  // Dropping the table drops its indexes and constraints with it.
  pgm.dropTable('monitors');
};
