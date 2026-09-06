import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Validation message, announced with the input. */
  error?: ReactNode;
  /** Standing guidance, e.g. a password rule. Announced with the input too. */
  hint?: ReactNode;
}

/**
 * A labelled input.
 *
 * The label is bound to the input by a generated id rather than left to each
 * form to remember, and the hint and error are wired through
 * `aria-describedby` so a screen reader hears them rather than encountering
 * loose text near the field. That association is the whole reason this exists.
 */
export function Field({ label, error, hint, id, ...props }: FieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  const describedBy = [hint ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <input
        {...props}
        id={inputId}
        className="field__input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {hint ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
