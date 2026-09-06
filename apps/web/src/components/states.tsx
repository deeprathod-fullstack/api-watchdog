import type { ReactNode } from 'react';

import { Button } from './Button.js';

/**
 * The three states every data-backed screen has to render.
 *
 * Keeping them here means loading, failure and emptiness look and behave the
 * same everywhere, and a new screen cannot quietly forget one of them.
 */

export interface LoadingProps {
  /** Announced to assistive tech; also the visible text. */
  label?: string;
}

export function Loading({ label = 'Loading…' }: LoadingProps) {
  return (
    <div className="state" role="status" aria-live="polite">
      {label}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  /** Must already be a user-safe message — see `toApiError`. */
  message: string;
  onRetry?: () => void;
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="state state--error" role="alert">
      <h2 className="state__title">{title}</h2>
      <p className="state__message">{message}</p>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  message?: string;
  action?: ReactNode;
}

export function EmptyState({ title, message, action }: EmptyStateProps) {
  return (
    <div className="state state--empty">
      <h2 className="state__title">{title}</h2>
      {message ? <p className="state__message">{message}</p> : null}
      {action}
    </div>
  );
}
