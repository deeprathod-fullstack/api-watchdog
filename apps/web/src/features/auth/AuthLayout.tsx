import type { ReactNode } from 'react';

export interface AuthLayoutProps {
  title: string;
  description: string;
  children: ReactNode;
  /** The link to the other credential screen. */
  footer: ReactNode;
}

/**
 * The frame shared by sign-in and registration.
 *
 * These two screens sit outside the app shell — there is no navigation to show
 * to someone who is not signed in — so they need their own branding and their
 * own `<h1>`. One card, centred, narrow enough to read on a phone.
 */
export function AuthLayout({
  title,
  description,
  children,
  footer,
}: AuthLayoutProps) {
  return (
    <main className="auth">
      <div className="auth__card">
        <p className="auth__brand">API Watchdog</p>
        <h1 className="auth__title">{title}</h1>
        <p className="auth__description">{description}</p>

        {children}

        <p className="auth__footer">{footer}</p>
      </div>
    </main>
  );
}
