import { useId, useState } from 'react';

import { Button } from '../../components/Button.js';
import {
  ALLOWED_HEADER_NAMES,
  MAX_HEADERS,
  validateHeaderValue,
  type AllowedHeaderName,
} from './validation.js';

export interface HeadersEditorProps {
  headers: Record<string, string>;
  onChange: (headers: Record<string, string>) => void;
  disabled?: boolean;
}

/**
 * The optional request headers a check will send.
 *
 * A fixed name dropdown rather than a free-text field. These headers are stored
 * in plaintext and travel to a third-party endpoint the user chose, so the UI
 * offers the three non-secret names V1 supports and gives credentials nowhere
 * to go. Nothing here is presented as a secret, because nothing here may be one.
 *
 * Values are never logged, and never rendered anywhere but their own input.
 */
export function HeadersEditor({
  headers,
  onChange,
  disabled = false,
}: HeadersEditorProps) {
  const nameId = useId();
  const valueId = useId();

  const [name, setName] = useState<AllowedHeaderName>(ALLOWED_HEADER_NAMES[0]);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const entries = Object.entries(headers);
  const atLimit = entries.length >= MAX_HEADERS;

  function handleAdd() {
    const valueError = validateHeaderValue(value);
    if (valueError) {
      setError(valueError);
      return;
    }

    // One value per header name: the payload is an object, so a duplicate would
    // silently overwrite rather than add. Saying so is better than surprising
    // someone.
    if (name in headers) {
      setError(`${name} is already set. Remove it first to change the value.`);
      return;
    }

    if (atLimit) {
      setError(`At most ${String(MAX_HEADERS)} headers.`);
      return;
    }

    onChange({ ...headers, [name]: value.trim() });
    setValue('');
    setError(null);
  }

  function handleRemove(headerName: string) {
    const next = { ...headers };
    delete next[headerName];
    onChange(next);
    setError(null);
  }

  return (
    <fieldset className="headers">
      <legend className="headers__legend">
        Request headers <span className="headers__optional">Optional</span>
      </legend>
      <p className="headers__hint">
        Sent with every check. Only non-secret headers are supported — never an
        API key, token or cookie. Header values are stored in plain text and
        travel to the endpoint you chose.
      </p>

      {entries.length > 0 ? (
        <ul className="headers__list">
          {entries.map(([headerName, headerValue]) => (
            <li className="headers__item" key={headerName}>
              <span className="headers__name">{headerName}</span>
              <span className="headers__value">{headerValue}</span>
              {/* Named for the header it removes: several rows each show a
                  control reading "Remove", and on its own that says nothing
                  about which one it acts on. */}
              <Button
                variant="subtle-danger"
                disabled={disabled}
                aria-label={`Remove ${headerName} header`}
                onClick={() => {
                  handleRemove(headerName);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="headers__empty">
          <span className="headers__empty-title">No custom headers</span>
          Add one below if the endpoint needs it.
        </p>
      )}

      <div className="headers__add">
        <div className="field">
          <label className="field__label" htmlFor={nameId}>
            Header name
          </label>
          <select
            className="field__input"
            id={nameId}
            value={name}
            disabled={disabled || atLimit}
            onChange={(event) => {
              setName(event.target.value as AllowedHeaderName);
              setError(null);
            }}
          >
            {ALLOWED_HEADER_NAMES.map((allowed) => (
              <option key={allowed} value={allowed}>
                {allowed}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={valueId}>
            Header value
          </label>
          <input
            className="field__input"
            id={valueId}
            value={value}
            disabled={disabled || atLimit}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${valueId}-error` : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
          />
        </div>

        {/* Not a submit button: pressing Enter in this form must submit the
            monitor, not add a header. */}
        <Button
          variant="secondary"
          disabled={disabled || atLimit}
          onClick={handleAdd}
        >
          Add header
        </Button>
      </div>

      {error ? (
        <p className="field__error" id={`${valueId}-error`} role="alert">
          {error}
        </p>
      ) : null}
      {atLimit ? (
        <p className="headers__hint">
          Maximum of {MAX_HEADERS} headers reached.
        </p>
      ) : null}
    </fieldset>
  );
}
