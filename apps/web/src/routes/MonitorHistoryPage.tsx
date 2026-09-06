import { useParams } from 'react-router-dom';

import { Page } from '../components/Page.js';
import { EmptyState } from '../components/states.js';

export function MonitorHistoryPage() {
  const { id = '' } = useParams<{ id: string }>();

  return (
    <Page title="Check history" description={`Monitor ${id}`}>
      <EmptyState
        title="History is not built yet"
        message="Check results and incidents arrive with the history work."
      />
    </Page>
  );
}
