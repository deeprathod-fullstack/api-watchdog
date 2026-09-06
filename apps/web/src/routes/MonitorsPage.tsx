import { Page } from '../components/Page.js';
import { EmptyState } from '../components/states.js';

export function MonitorsPage() {
  return (
    <Page title="Monitors" description="Endpoints this account is watching.">
      <EmptyState
        title="No monitors listed yet"
        message="The monitor list and create form arrive with the monitors work."
      />
    </Page>
  );
}
