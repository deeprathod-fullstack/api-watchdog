import { useEffect } from 'react';

const SUFFIX = 'API Watchdog';

/**
 * Name the page in the browser.
 *
 * A single-page app changes route without changing `document.title`, so every
 * screen shares the one title from `index.html`. That makes browser history and
 * a row of open tabs useless for telling one screen from another, and it costs
 * a screen-reader user the page name they are given on every ordinary
 * navigation.
 *
 * The title is set in an effect rather than during render because it is a
 * change to something outside React, which is exactly what effects are for.
 */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    // `null` means "not known yet" — a page still loading the thing it is named
    // after. Leaving the previous title alone beats flashing a placeholder.
    if (title === null) return;

    document.title = title === SUFFIX ? title : `${title} · ${SUFFIX}`;
  }, [title]);
}
