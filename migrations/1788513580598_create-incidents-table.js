/**
 * Create the `incidents` table: one row per period a monitor was unhealthy.
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
    'incidents',
    {
      // UUID rather than the bigint used by check_results: incidents are low
      // volume (one per outage, not one per check) and user-facing, so they
      // follow the same pattern as users and monitors.
      id: {
        type: 'uuid',
        primaryKey: true,
        default: pgm.func('gen_random_uuid()'),
      },
      monitor_id: {
        type: 'uuid',
        notNull: true,
        references: 'monitors(id)',
        onDelete: 'CASCADE',
      },
      // Redundant with resolved_at by design, kept for readable queries. The
      // table-level CHECK below is what stops the two from ever disagreeing.
      status: {
        type: 'text',
        notNull: true,
        check: "status IN ('open', 'resolved')",
      },
      // The checked_at of the FIRST failure in the streak, not of the failure
      // that crossed the threshold. Downtime began at failure #1; recording
      // the threshold moment instead would under-report every outage by
      // threshold x interval.
      //
      // No default: the worker always supplies this from the check row. A
      // now() default would silently record the wrong instant whenever the
      // caller forgot.
      started_at: {
        type: 'timestamptz',
        notNull: true,
      },
      // NULL is the definition of "still open". Set to the checked_at of the
      // successful recovery check.
      resolved_at: {
        type: 'timestamptz',
      },
      // Every consecutive failure in this incident, including the ones before
      // the threshold was reached. No upper bound: a long outage produces a
      // genuinely large count.
      failure_count: {
        type: 'integer',
        notNull: true,
        check: 'failure_count > 0',
      },
    },
    {
      constraints: {
        check: [
          // Makes the status/resolved_at redundancy safe: the pair cannot
          // drift, whatever the application does.
          "(status = 'open' AND resolved_at IS NULL) OR (status = 'resolved' AND resolved_at IS NOT NULL)",
          // An incident cannot end before it started.
          'resolved_at IS NULL OR resolved_at >= started_at',
        ],
      },
    },
  );

  // At most one open incident per monitor, enforced by storage rather than by
  // application logic.
  //
  // The obvious "SELECT for an open incident, then INSERT if none" is a
  // time-of-check-to-time-of-use race: two workers handling the same monitor,
  // or one BullMQ job delivered twice, both read "none" and both insert. This
  // index makes the second insert fail with a unique violation, which the
  // worker reads as "someone else already opened it".
  //
  // Partial (WHERE status = 'open'), so resolved rows are not in the index at
  // all and a monitor can accumulate unlimited resolved incidents.
  pgm.createIndex('incidents', 'monitor_id', {
    name: 'incidents_one_open_per_monitor_idx',
    unique: true,
    where: "status = 'open'",
  });

  // Dashboard history: "this monitor's incidents, newest first". Mirrors the
  // check_results history index.
  pgm.createIndex(
    'incidents',
    ['monitor_id', { name: 'started_at', sort: 'DESC' }],
    { name: 'incidents_monitor_id_started_at_idx' },
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {void}
 */
export const down = (pgm) => {
  // Dropping the table drops its indexes and constraints with it.
  pgm.dropTable('incidents');
};
