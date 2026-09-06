import { Button } from '../../components/Button.js';

export interface PagerProps {
  /** Names what is being paged, for the controls' accessible names. */
  label: string;
  offset: number;
  pageSize: number;
  count: number;
  hasPrevious: boolean;
  hasNext: boolean;
  busy: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

/**
 * Previous/next controls for one history section.
 *
 * The range is stated rather than a page number, because the backend's
 * limit/offset contract carries no total — "26–50" is true, "page 2 of 7" would
 * be a guess. Both buttons are disabled while a request is in flight, which is
 * what stops a rapid click skipping a page or issuing a duplicate request.
 */
export function Pager({
  label,
  offset,
  pageSize,
  count,
  hasPrevious,
  hasNext,
  busy,
  onPrevious,
  onNext,
}: PagerProps) {
  if (!hasPrevious && !hasNext) return null;

  const first = count === 0 ? 0 : offset + 1;
  const last = offset + count;

  return (
    <nav className="pager" aria-label={`${label} pagination`}>
      <p className="pager__range" aria-live="polite">
        {count === 0
          ? 'No rows on this page'
          : `Showing ${String(first)}–${String(last)}`}
      </p>
      <div className="pager__controls">
        <Button
          variant="secondary"
          onClick={onPrevious}
          disabled={busy || !hasPrevious}
          aria-label={`Previous page of ${label}`}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          onClick={onNext}
          disabled={busy || !hasNext}
          aria-label={`Next page of ${label}`}
        >
          Next
        </Button>
      </div>
      <p className="pager__note">
        {/* Said once, plainly, rather than leaving someone to wonder why the
            last page can look like it has a successor. */}
        Pages are {pageSize} rows. The API reports no total, so Next stays
        available until a page comes back short.
      </p>
    </nav>
  );
}
