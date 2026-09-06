import { pausedCount } from './health.js';
import type { DashboardSummary } from './types.js';

export interface SummaryCardsProps {
  summary: DashboardSummary;
}

/**
 * The counts across the top.
 *
 * Every number comes from the backend's own summary; the only arithmetic is
 * `paused = total - active`, which is the one thing `active` can mean. Each
 * card carries a short explanation, because "unknown" and "failing" are not
 * self-evident and a dashboard nobody can read is a dashboard nobody trusts.
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
      tone: 'bad',
    },
    {
      key: 'unknown',
      label: 'No check yet',
      value: summary.unknown,
      note: 'Never been checked',
      tone: 'neutral',
    },
    {
      key: 'paused',
      label: 'Paused',
      value: pausedCount(summary),
      note: 'Not being checked on a schedule',
      tone: 'neutral',
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
