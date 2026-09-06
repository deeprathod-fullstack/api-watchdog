import { checkErrorLabel } from '../../lib/check-error-types.js';
import type { CheckResult } from './types.js';

export interface CheckResultSummaryProps {
  result: CheckResult;
}

/**
 * The outcome of a manual check.
 *
 * The distinction this component exists to make: it is only ever rendered when
 * the *check ran*. A failure shown here is the monitored endpoint's failure,
 * not a failed request to API Watchdog — those are reported separately, as an
 * error. Conflating the two would make the tool lie about which system is down.
 *
 * Status is carried by text as well as colour, so it survives a monochrome
 * display and a screen reader.
 */
export function CheckResultSummary({ result }: CheckResultSummaryProps) {
  const failed = result.status === 'failure';
  const errorLabel = checkErrorLabel(result.errorType);

  return (
    <div
      className={`check ${failed ? 'check--failure' : 'check--success'}`}
      role="status"
    >
      <p className="check__headline">
        {failed ? 'Check failed' : 'Check passed'}
        {errorLabel ? ` — ${errorLabel}` : ''}
      </p>

      <dl className="check__facts">
        {result.httpStatus !== null ? (
          <div className="check__fact">
            <dt>HTTP status</dt>
            <dd>{result.httpStatus}</dd>
          </div>
        ) : null}
        <div className="check__fact">
          <dt>Response time</dt>
          <dd>{result.responseTimeMs} ms</dd>
        </div>
        <div className="check__fact">
          <dt>Checked at</dt>
          <dd>{new Date(result.checkedAt).toLocaleTimeString()}</dd>
        </div>
      </dl>

      {/* The backend authors these messages from a closed set of templates and
          truncates them; no response body or header value can reach here. */}
      {result.errorMessage ? (
        <p className="check__message">{result.errorMessage}</p>
      ) : null}
    </div>
  );
}
