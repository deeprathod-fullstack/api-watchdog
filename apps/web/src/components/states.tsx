import type { ReactNode } from 'react';

import { Button } from './Button.js';

/**
 * The three states every data-backed screen has to render.
 *
 * Keeping them here means loading, failure and emptiness look and behave the
 * same everywhere, and a new screen cannot quietly forget one of them.
 */

/**
 * Where the state sits in the page's heading order.
 *
 * A state that *is* a page's content sits under its `<h1>` and is a level 2.
 * One rendered inside a section that already has its own `<h2>` — the history
 * page's two sections, say — must be a level 3, or the document grows two
 * sibling headings that claim to be peers when one describes the other.
 */
export type StateHeadingLevel = 2 | 3;

interface StateHeadingProps {
  level: StateHeadingLevel;
  children: ReactNode;
}

function StateHeading({ level, children }: StateHeadingProps) {
  const Heading = level === 3 ? 'h3' : 'h2';

  return <Heading className="state__title">{children}</Heading>;
}

export interface LoadingProps {
  /** Announced to assistive tech; also the visible text. */
  label?: string;
}

export function Loading({ label = 'Loading…' }: LoadingProps) {
  return (
    <p className="state" role="status">
      {label}
    </p>
  );
}

export interface ErrorStateProps {
  title?: string;
  /** Must already be a user-safe message — see `toApiError`. */
  message: string;
  onRetry?: () => void;
  headingLevel?: StateHeadingLevel;
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  headingLevel = 2,
}: ErrorStateProps) {
  return (
    <div className="state state--error" role="alert">
      <StateHeading level={headingLevel}>{title}</StateHeading>
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
  headingLevel?: StateHeadingLevel;
}

export function EmptyState({
  title,
  message,
  action,
  headingLevel = 2,
}: EmptyStateProps) {
  return (
    <div className="state state--empty">
      <StateHeading level={headingLevel}>{title}</StateHeading>
      {message ? <p className="state__message">{message}</p> : null}
      {action}
    </div>
  );
}
