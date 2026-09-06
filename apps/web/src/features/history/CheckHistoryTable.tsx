import {
  checkErrorDescription,
  checkErrorLabel,
} from '../../lib/check-error-types.js';
import type { CheckResult } from './types.js';

export interface CheckHistoryTableProps {
  checks: CheckResult[];
}

/**
 * Absolute local time for a stored instant.
 *
 * The backend serialises UTC ISO-8601, so `new Date` parses the instant
 * unambiguously and `toLocaleString` renders it in the reader's own zone. No
 * string slicing, and no re-interpretation of the offset.
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

/**
 * What a failed check says for itself.
 *
 * The stored message is preferred — the backend authors it from a closed set of
 * templates, truncates it, and never lets a response body or header value into
 * it. When the column is null, the classifier's own description stands in
 * rather than a blank cell.
 */
function describeError(check: CheckResult): string {
  if (check.status === 'success') return '—';

  return (
    check.errorMessage ??
    checkErrorDescription(check.errorType) ??
    'The check failed.'
  );
}

/**
 * Every stored check for one monitor, newest first, as the API returned them.
 *
 * A table, because this is tabular: dense, scannable, and comparable row to
 * row. Rendered as ordinary React text throughout — no `dangerouslySetInnerHTML`
 * anywhere — so a hostile monitor name or error message is escaped, not run.
 */
export function CheckHistoryTable({ checks }: CheckHistoryTableProps) {
  return (
    <div className="table-scroll">
      <table className="history">
        <caption className="visually-hidden">
          Check results for this monitor, newest first
        </caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Result</th>
            <th scope="col">HTTP</th>
            <th scope="col">Response</th>
            <th scope="col">Error</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => {
            const failed = check.status === 'failure';
            const label = checkErrorLabel(check.errorType);

            return (
              <tr key={check.id}>
                <th scope="row" className="history__time">
                  {formatTimestamp(check.checkedAt)}
                </th>
                <td>
                  {/* The word carries the status; colour only reinforces it. */}
                  <span
                    className={`badge badge--${failed ? 'failing' : 'healthy'}`}
                  >
                    {failed ? 'Failure' : 'Success'}
                  </span>
                </td>
                {/* A check that never got a response has no status. It is a
                    dash, never "0" and never "HTTP 0". */}
                <td className="history__mono">{check.httpStatus ?? '—'}</td>
                {/* Likewise a response time: absent is absent, not 0 ms. */}
                <td className="history__mono">
                  {check.responseTimeMs === null
                    ? '—'
                    : `${String(check.responseTimeMs)} ms`}
                </td>
                <td className="history__error">
                  {failed && label ? (
                    <span className="history__error-type">{label}</span>
                  ) : null}
                  <span className="history__error-message">
                    {describeError(check)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
