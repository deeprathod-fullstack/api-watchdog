import { Link } from 'react-router-dom';

import { Page } from '../components/Page.js';
import { paths } from '../app/paths.js';
import { useDocumentTitle } from '../app/useDocumentTitle.js';

export function NotFoundPage() {
  useDocumentTitle('Page not found');

  return (
    <Page title="Page not found">
      <p>
        That page does not exist.{' '}
        <Link to={paths.dashboard}>Go to the dashboard</Link>.
      </p>
    </Page>
  );
}
