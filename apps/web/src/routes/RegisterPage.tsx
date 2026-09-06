import { Link } from 'react-router-dom';

import { paths } from '../app/paths.js';
import { AuthLayout } from '../features/auth/AuthLayout.js';
import { RegisterForm } from '../features/auth/RegisterForm.js';

export function RegisterPage() {
  return (
    <AuthLayout
      title="Create an account"
      description="Start monitoring public HTTP endpoints in a couple of minutes."
      footer={
        <>
          Already have an account? <Link to={paths.login}>Sign in</Link>
        </>
      }
    >
      <RegisterForm />
    </AuthLayout>
  );
}
