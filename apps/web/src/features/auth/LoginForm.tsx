import { useState, type FormEvent } from 'react';

import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { authErrorMessage } from './error-messages.js';
import { useAuth } from './useAuth.js';
import { validateEmail, validateLoginPassword } from './validation.js';

interface FieldErrors {
  email?: string;
  password?: string;
}

/**
 * The sign-in form.
 *
 * It does not navigate on success. Setting the session flips the route guard,
 * and the guard decides where to go — one place that owns the redirect instead
 * of two racing to perform it.
 */
export function LoginForm() {
  const { login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // A double-click, or Enter held down, must not spend two attempts against
    // the credential rate limiter.
    if (submitting) return;

    const errors: FieldErrors = {
      email: validateEmail(email),
      password: validateLoginPassword(password),
    };

    if (errors.email ?? errors.password) {
      setFieldErrors(errors);
      setFormError(null);
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);

    try {
      await login({ email: email.trim(), password });
      // Deliberately no `setSubmitting(false)` and no navigate: the guard
      // redirects, and the button stays disabled until it does.
    } catch (error) {
      // The email stays in state so it is not retyped; the password is
      // cleared, since a wrong one is worth nothing and leaving it in a live
      // DOM node is needless exposure. Nothing here is logged — the error can
      // carry the submitted address.
      setPassword('');
      setFormError(authErrorMessage(error));
      setSubmitting(false);
    }
  }

  return (
    <form
      className="auth__form"
      onSubmit={(e) => void handleSubmit(e)}
      noValidate
    >
      {formError ? (
        <p className="auth__error" role="alert">
          {formError}
        </p>
      ) : null}

      <Field
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
        autoFocus
        required
        value={email}
        error={fieldErrors.email}
        disabled={submitting}
        onChange={(e) => {
          setEmail(e.target.value);
        }}
      />

      <Field
        label="Password"
        type="password"
        name="password"
        autoComplete="current-password"
        required
        value={password}
        error={fieldErrors.password}
        disabled={submitting}
        onChange={(e) => {
          setPassword(e.target.value);
        }}
      />

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
