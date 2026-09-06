import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Validation message or hint, announced with the input. */
  error?: ReactNode;
}

/**
 * A labelled input.
 *
 * The label is bound to the input by a generated id rather than left to each
 * form to remember, and an error is wired through `aria-describedby` so a
 * screen reader hears it. That association is the whole reason this exists.
 */
export function Field({ label, error, id, ...props }: FieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

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
        aria-describedby={error ? errorId : undefined}
      />
      {error ? (
        <p className="field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
