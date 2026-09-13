import type { DashboardSummary } from './types.js';

export interface SummaryCardsProps {
  summary: DashboardSummary;
}

/**
 * The counts across the top.
 *
 * Five, and every one comes straight from the backend's summary — no
 * arithmetic, no derived metric, nothing the API did not report. Each carries a
 * short explanation, because "failing" and "active" are not self-evident and a
 * dashboard nobody can read is a dashboard nobody trusts.
 *
 * Monitors that have never been checked are deliberately not a sixth card.
 * They are visible where they matter — as "No check yet" in the table below —
 * and a card that reads 0 on almost every account is chrome, not information.
 */
export function SummaryCards({ summary }: SummaryCardsProps) {
  const cards = [
    {
      key: 'total',
      label: 'Monitors',
      value: summary.total,
      note: 'Endpoints on this account',
      tone: 'neutral',
    },
    {
      key: 'active',
      label: 'Active',
      value: summary.active,
      note: 'Checked on a schedule',
      tone: 'neutral',
    },
    {
      key: 'healthy',
      label: 'Healthy',
      value: summary.healthy,
      note: 'Last check passed',
      tone: 'good',
    },
    {
      key: 'failing',
      label: 'Failing',
      value: summary.failing,
      note: 'Last check failed',
      // Only tinted when there is something to look at: a calm dashboard is
      // one where the red means something.
      tone: summary.failing > 0 ? 'bad' : 'neutral',
    },
    {
      key: 'incidents',
      label: 'Open incidents',
      value: summary.openIncidents,
      note: 'Unresolved failures',
      tone: summary.openIncidents > 0 ? 'bad' : 'neutral',
    },
  ] as const;

  return (
    <ul className="cards" aria-label="Monitoring summary">
      {cards.map((card) => (
        <li className={`card card--${card.tone}`} key={card.key}>
          {/* The number is announced with its own label, so a screen reader
              never reads a bare figure. */}
          <p className="card__label">{card.label}</p>
          <p className="card__value">{card.value}</p>
          <p className="card__note">{card.note}</p>
        </li>
      ))}
    </ul>
  );
}
