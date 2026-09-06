/**
 * The scheduling boundary, expressed without mentioning Redis or BullMQ.
 *
 * Monitor CRUD needs to say "this monitor's schedule should now look like
 * this". It has no business knowing what a job scheduler is, and the tests for
 * ownership and validation have no business needing a running Redis. So the
 * capability is an interface here, the BullMQ implementation lives in
 * `checks-queue.ts`, and the process entry point decides which one is used.
 */

/** Everything scheduling needs to know about a monitor. Deliberately tiny. */
export interface SchedulableMonitor {
  readonly id: string;
  readonly intervalSeconds: number;
  readonly active: boolean;
}

export interface CheckScheduler {
  /**
   * Make the schedule match this row.
   *
   * One method rather than schedule/pause/resume/reschedule, because the caller
   * always knows the row it just wrote and the desired state is a pure function
   * of it: active means "a schedule every `intervalSeconds`", paused means "no
   * schedule". Create, resume, pause and an interval change are all the same
   * call, which is one fewer way for a code path to forget one of them.
   *
   * Implementations must be idempotent: calling this with an unchanged row is
   * expected and must not produce a second schedule.
   */
  sync(monitor: SchedulableMonitor): Promise<void>;

  /** Drop this monitor's schedule. Removing an absent one is not an error. */
  remove(monitorId: string): Promise<void>;
}

/**
 * A scheduler that does nothing.
 *
 * For tests that exercise CRUD, auth or validation and have no interest in
 * scheduling. It is a real no-op rather than a throwing stub because the CRUD
 * routes now legitimately call `sync` on every write, so throwing would only
 * mean every one of those tests had to know about scheduling.
 *
 * The scheduling behaviour itself is covered against a real Redis in
 * `scheduling.test.ts`.
 */
export const noopScheduler: CheckScheduler = {
  sync: () => Promise.resolve(),
  remove: () => Promise.resolve(),
};
