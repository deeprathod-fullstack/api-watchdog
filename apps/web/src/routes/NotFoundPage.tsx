import { Link } from 'react-router-dom';

import { Page } from '../components/Page.js';
import { paths } from '../app/paths.js';

export function NotFoundPage() {
  return (
    <Page title="Page not found">
      <p>
        That page does not exist.{' '}
        <Link to={paths.dashboard}>Go to the dashboard</Link>.
      </p>
    </Page>
  );
}
