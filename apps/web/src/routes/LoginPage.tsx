import { Link } from 'react-router-dom';

import { paths } from '../app/paths.js';
import { AuthLayout } from '../features/auth/AuthLayout.js';
import { LoginForm } from '../features/auth/LoginForm.js';

export function LoginPage() {
  return (
    <AuthLayout
      title="Sign in"
      description="Monitor your API endpoints and get a record of every check."
      footer={
        <>
          Need an account? <Link to={paths.register}>Create one</Link>
        </>
      }
    >
      <LoginForm />
    </AuthLayout>
  );
}
