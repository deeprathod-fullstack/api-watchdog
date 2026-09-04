/**
 * Create the `check_results` table: one row per attempt to check one monitor.
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
    'check_results',
    {
      // bigint identity rather than UUID: this is the one high-volume table
      // (every monitor times every interval, forever). A sequential key is
      // half the width and appends to the right edge of the btree instead of
      // scattering random inserts across it. Safe here because these ids are
      // never public handles — history is always fetched per monitor, so there
      // is nothing to enumerate.
      id: {
        type: 'bigint',
        primaryKey: true,
        sequenceGenerated: { precedence: 'ALWAYS' },
      },
      // Results are meaningless without their monitor, so they go with it.
      monitor_id: {
        type: 'uuid',
        notNull: true,
        references: 'monitors(id)',
        onDelete: 'CASCADE',
      },
      // A CHECK rather than a Postgres enum type: widening a CHECK is a plain
      // ALTER, while adding an enum value is DDL with awkward transaction
      // rules. Two values do not justify the heavier tool.
      status: {
        type: 'text',
        notNull: true,
        check: "status IN ('success', 'failure')",
      },
      // Nullable on purpose: a timeout, DNS failure, or refused connection
      // never produced a response. A 0 or -1 sentinel would be a lie every
      // read site had to remember to decode.
      http_status: {
        type: 'integer',
        check: 'http_status IS NULL OR http_status BETWEEN 100 AND 599',
      },
      // Non-negative, not positive: a sub-millisecond response rounds to 0.
      // For a timeout this records how long we waited before giving up, which
      // is still worth charting.
      response_time_ms: {
        type: 'integer',
        notNull: true,
        check: 'response_time_ms >= 0',
      },
      // A short classifier ('timeout', 'dns', 'connection_refused',
      // 'status_mismatch'), never a response body and never text echoed back
      // from the target.
      error_type: {
        type: 'text',
      },
      // The human-readable detail behind error_type, for display on the
      // dashboard. Nullable: a successful check has nothing to say. This is
      // attacker-influenced text — it originates from the monitored host — so
      // it is rendered as text, never as markup, and never logged verbatim.
      error_message: {
        type: 'text',
      },
      checked_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('now()'),
      },
    },
    {
      constraints: {
        // Cross-column, so it cannot live on a column definition. A
        // "successful check that carries an error" is a contradiction that
        // would quietly corrupt every uptime calculation built on this table.
        // Both error columns are covered, so a success cannot smuggle in a
        // message without a type either.
        check:
          "status = 'failure' OR (error_type IS NULL AND error_message IS NULL)",
      },
    },
  );

  // The history query is `WHERE monitor_id = $1 ORDER BY checked_at DESC`:
  // the leading column filters, the second supplies the ordering so no sort
  // step is needed. (PostgreSQL can scan a btree backwards, so an ASC index
  // would also serve — DESC costs nothing and states the intent.)
  pgm.createIndex(
    'check_results',
    ['monitor_id', { name: 'checked_at', sort: 'DESC' }],
    { name: 'check_results_monitor_id_checked_at_idx' },
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const down = (pgm) => {
  // Dropping the table drops its index and constraints with it.
  pgm.dropTable('check_results');
};
