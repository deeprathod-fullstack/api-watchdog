import { Component, type ErrorInfo, type ReactNode } from 'react';

import { ErrorState } from '../components/states.js';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Last line of defence for a render-time crash.
 *
 * Without it, one thrown error unmounts the whole tree and leaves a blank
 * page. The thrown error is never shown to the user: it can carry request
 * data, so it goes to the console for a developer and the user sees a generic
 * message. Class component because React offers no hook equivalent.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // TODO(phase-4): forward to the same place the backend logs go.
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <ErrorState
          title="This screen failed to load"
          message="An unexpected error occurred. Reload the page to try again."
          onRetry={() => {
            window.location.reload();
          }}
        />
      );
    }

    return this.props.children;
  }
}
