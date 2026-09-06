import { useState, type FormEvent } from 'react';

import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { authErrorMessage } from './error-messages.js';
import { useAuth } from './useAuth.js';
import {
  PASSWORD_MIN_LENGTH,
  validateEmail,
  validateName,
  validateNewPassword,
  validatePasswordConfirmation,
} from './validation.js';

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
}

/**
 * The registration form.
 *
 * `confirmPassword` never leaves this component: it is a typo check for the
 * person filling the form, not part of the API contract, and sending it would
 * put a second copy of the password on the wire and into any request log for
 * no benefit.
 */
export function RegisterForm() {
  const { register } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submitting) return;

    const errors: FieldErrors = {
      name: validateName(name),
      email: validateEmail(email),
      password: validateNewPassword(password),
      confirmPassword: validatePasswordConfirmation(password, confirmPassword),
    };

    if (Object.values(errors).some(Boolean)) {
      setFieldErrors(errors);
      setFormError(null);
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);

    try {
      await register({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      // The guard redirects once the session exists; see LoginForm.
    } catch (error) {
      // Both password fields are cleared rather than kept for a retry: a
      // failed registration is usually a taken email, and the next attempt
      // should not leave the secret sitting in the DOM meanwhile.
      setPassword('');
      setConfirmPassword('');
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
        label="Name"
        name="name"
        autoComplete="name"
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
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
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
        autoComplete="new-password"
        required
        value={password}
        error={fieldErrors.password}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        disabled={submitting}
        onChange={(e) => {
          setPassword(e.target.value);
        }}
      />

      <Field
        label="Confirm password"
        type="password"
        name="confirmPassword"
        autoComplete="new-password"
        required
        value={confirmPassword}
        error={fieldErrors.confirmPassword}
        disabled={submitting}
        onChange={(e) => {
          setConfirmPassword(e.target.value);
        }}
      />

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  );
}
