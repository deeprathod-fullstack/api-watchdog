import { Link, useParams } from 'react-router-dom';

import { Page } from '../components/Page.js';
import { EmptyState } from '../components/states.js';
import { paths } from '../app/paths.js';

export function MonitorDetailPage() {
  const { id = '' } = useParams<{ id: string }>();

  return (
    <Page title="Monitor" description={`Monitor ${id}`}>
      <EmptyState
        title="Monitor details are not built yet"
        action={<Link to={paths.monitorHistory(id)}>View check history</Link>}
      />
    </Page>
  );
}
