import { useState, type FormEvent } from 'react';

import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { HeadersEditor } from './HeadersEditor.js';
import type { CreateMonitorInput, Monitor } from './types.js';
import {
  EXPECTED_STATUS_MAX,
  EXPECTED_STATUS_MIN,
  INTERVAL_MAX_SECONDS,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  toInteger,
  validateExpectedStatus,
  validateInterval,
  validateName,
  validateTimeout,
  validateUrl,
} from './validation.js';

interface FieldErrors {
  name?: string;
  url?: string;
  expectedStatus?: string;
  intervalSeconds?: string;
  timeoutMs?: string;
}

export interface MonitorFormProps {
  /** Present when editing; its values seed the form. */
  monitor?: Monitor;
  submitLabel: string;
  submittingLabel: string;
  /** Rejects to signal failure; the form shows the message and stays put. */
  onSubmit: (input: CreateMonitorInput) => Promise<void>;
  onCancel: () => void;
  /** A server-side failure, already translated for display. */
  submitError?: string | null;
}

const DEFAULTS = {
  expectedStatus: '200',
  intervalSeconds: '300',
  timeoutMs: '5000',
};

/**
 * One form for both creating and editing.
 *
 * The two screens differ only in what seeds the fields and what the submit
 * handler does with them, so they share this rather than diverging into two
 * copies that drift. Numeric fields are held as strings because that is what an
 * input gives back, and parsing once at submit time is clearer than fighting
 * `''` becoming `0` on every keystroke.
 */
export function MonitorForm({
  monitor,
  submitLabel,
  submittingLabel,
  onSubmit,
  onCancel,
  submitError = null,
}: MonitorFormProps) {
  const [name, setName] = useState(monitor?.name ?? '');
  const [url, setUrl] = useState(monitor?.url ?? '');
  const [expectedStatus, setExpectedStatus] = useState(
    monitor ? String(monitor.expectedStatus) : DEFAULTS.expectedStatus,
  );
  const [intervalSeconds, setIntervalSeconds] = useState(
    monitor ? String(monitor.intervalSeconds) : DEFAULTS.intervalSeconds,
  );
  const [timeoutMs, setTimeoutMs] = useState(
    monitor ? String(monitor.timeoutMs) : DEFAULTS.timeoutMs,
  );
  const [headers, setHeaders] = useState<Record<string, string>>(
    monitor?.headers ?? {},
  );

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // A double-click must not create two monitors.
    if (submitting) return;

    const errors: FieldErrors = {
      name: validateName(name),
      url: validateUrl(url),
      expectedStatus: validateExpectedStatus(expectedStatus),
      intervalSeconds: validateInterval(intervalSeconds),
      timeoutMs: validateTimeout(timeoutMs, intervalSeconds),
    };

    if (Object.values(errors).some(Boolean)) {
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setSubmitting(true);

    try {
      await onSubmit({
        name: name.trim(),
        url: url.trim(),
        method: 'GET',
        expectedStatus: toInteger(expectedStatus),
        intervalSeconds: toInteger(intervalSeconds),
        timeoutMs: toInteger(timeoutMs),
        headers,
      });
      // On success the caller navigates away; leaving the button disabled
      // avoids a flash of an enabled form mid-transition.
    } catch {
      // The caller owns the message — it needs the ApiError to translate it —
      // and passes it back through `submitError`. Nothing is logged: the error
      // carries the submitted URL and header values.
      setSubmitting(false);
    }
  }

  return (
    <form
      className="monitor-form"
      onSubmit={(e) => void handleSubmit(e)}
      noValidate
    >
      {submitError ? (
        <p className="form__error" role="alert">
          {submitError}
        </p>
      ) : null}

      {/* Three bands, not eight boxes: what to watch, how to watch it, and
          what to send. Each is a decision the user makes separately. */}
      <fieldset className="form-section">
        <legend className="form-section__title">Monitor details</legend>
        <p className="form-section__description">
          The endpoint to watch and what to call it.
        </p>

        <Field
          label="Name"
          name="name"
          autoFocus
          required
          value={name}
          error={fieldErrors.name}
          disabled={submitting}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />

        <Field
          label="URL"
          name="url"
          type="url"
          inputMode="url"
          required
          placeholder="https://api.example.com/health"
          value={url}
          error={fieldErrors.url}
          hint="Public http:// or https:// endpoint, on the default port."
          disabled={submitting}
          onChange={(e) => {
            setUrl(e.target.value);
          }}
        />

        {/* Method is GET in V1: a stated fact rather than a select with one
          option. `readOnly` rather than `disabled` — a disabled input is
          removed from the tab order and skipped by most screen readers, which
          would hide the one field explaining the constraint from exactly the
          people who need it explained. */}
        <Field
          label="Method"
          name="method"
          value="GET"
          readOnly
          hint="V1 checks public GET endpoints only."
        />
      </fieldset>

      <fieldset className="form-section">
        <legend className="form-section__title">Check configuration</legend>
        <p className="form-section__description">
          What counts as a passing check, and how often it runs.
        </p>

        <div className="monitor-form__row">
          <Field
            label="Expected status"
            name="expectedStatus"
            type="number"
            inputMode="numeric"
            min={EXPECTED_STATUS_MIN}
            max={EXPECTED_STATUS_MAX}
            required
            value={expectedStatus}
            error={fieldErrors.expectedStatus}
            hint="The check passes when the endpoint returns this status."
            disabled={submitting}
            onChange={(e) => {
              setExpectedStatus(e.target.value);
            }}
          />

          <Field
            label="Check interval (seconds)"
            name="intervalSeconds"
            type="number"
            inputMode="numeric"
            min={1}
            max={INTERVAL_MAX_SECONDS}
            required
            value={intervalSeconds}
            error={fieldErrors.intervalSeconds}
            hint="How often a scheduled check runs."
            disabled={submitting}
            onChange={(e) => {
              setIntervalSeconds(e.target.value);
            }}
          />

          <Field
            label="Timeout (ms)"
            name="timeoutMs"
            type="number"
            inputMode="numeric"
            min={TIMEOUT_MIN_MS}
            max={TIMEOUT_MAX_MS}
            required
            value={timeoutMs}
            error={fieldErrors.timeoutMs}
            hint={`Between ${String(TIMEOUT_MIN_MS)} and ${String(TIMEOUT_MAX_MS)} ms.`}
            disabled={submitting}
            onChange={(e) => {
              setTimeoutMs(e.target.value);
            }}
          />
        </div>
      </fieldset>

      <div className="form-section">
        <HeadersEditor
          headers={headers}
          onChange={setHeaders}
          disabled={submitting}
        />
      </div>

      {/* Cancel first, primary last: the destructive-of-progress action sits
          away from where the pointer lands for the affirmative one. */}
      <div className="monitor-form__actions">
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? submittingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
