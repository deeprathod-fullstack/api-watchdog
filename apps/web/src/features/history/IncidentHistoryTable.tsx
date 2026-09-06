import type { Incident } from './types.js';

export interface IncidentHistoryTableProps {
  incidents: Incident[];
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

/**
 * Incidents for one monitor, newest first.
 *
 * Read-only, and deliberately so: incidents are opened and resolved by the
 * backend's incident engine when checks fail consecutively or a monitor
 * recovers. The API exposes no way to close one by hand, so this page offers no
 * control that would pretend otherwise.
 *
 * Open-ness comes from the explicit `status` field, never from a missing
 * `resolvedAt` — the backend states it, so there is nothing to infer.
 *
 * There is no duration column. The contract carries no duration, and computing
 * one from the two timestamps would be this page inventing a figure the API
 * never reported.
 */
export function IncidentHistoryTable({ incidents }: IncidentHistoryTableProps) {
  return (
    <div className="table-scroll">
      <table className="history">
        <caption className="visually-hidden">
          Incidents for this monitor, newest first
        </caption>
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Started</th>
            <th scope="col">Resolved</th>
            <th scope="col">Consecutive failures</th>
          </tr>
        </thead>
        <tbody>
          {incidents.map((incident) => {
            const open = incident.status === 'open';

            return (
              <tr key={incident.id}>
                <th scope="row">
                  <span
                    className={`badge badge--${open ? 'incident' : 'healthy'}`}
                  >
                    {open ? 'Open' : 'Resolved'}
                  </span>
                </th>
                <td>{formatTimestamp(incident.startedAt)}</td>
                {/* An open incident has no resolution time yet. */}
                <td>
                  {incident.resolvedAt === null
                    ? '—'
                    : formatTimestamp(incident.resolvedAt)}
                </td>
                {/* The backend's own count; nothing is derived here. */}
                <td>{incident.failureCount}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
