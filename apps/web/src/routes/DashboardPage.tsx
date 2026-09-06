import { Page } from '../components/Page.js';
import { EmptyState } from '../components/states.js';

export function DashboardPage() {
  return (
    <Page title="Dashboard" description="Health across all of your monitors.">
      <EmptyState
        title="Nothing here yet"
        message="Monitor counts, uptime and response times arrive with the dashboard work."
      />
    </Page>
  );
}
