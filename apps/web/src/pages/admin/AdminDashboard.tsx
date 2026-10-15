/**
 * Admin overview (§11).
 *
 * THE ADMIN'S QUESTION IS DIFFERENT FROM THE HOD'S. A HOD asks "what do I action next?"; an
 * admin asks "is this system being used, and is anything stuck?" So this page leads with
 * throughput, validation outcomes and the AI's state, then hands off to the operational
 * queue rather than duplicating it.
 *
 * EVERY FIGURE COMES FROM `GET /v1/analytics/summary`, aggregated in SQL. Nothing is summed
 * in the browser over a page of results, because a total computed from a partial list is
 * wrong in a way that looks right.
 *
 * `null` RENDERS AS AN EM DASH. A workspace with nothing resolved has no median resolution
 * time — showing "0h" there would be a factual claim the data does not support.
 */

import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type { AiStatus, AnalyticsSummary } from '../../lib/types.js';
import { Card, StatGrid, StatTile } from '../../components/data.js';
import { EmptyPane, ErrorPane, InlineAlert, SkeletonRows } from '../../components/states.js';
import { WorkspaceTag } from '../../components/badges.js';
import { formatCount, formatConfidence, formatDateTime, formatHours, humanise } from '../../lib/format.js';
import { useSession } from '../../lib/session.js';

export function AdminDashboard() {
  const { user } = useSession();

  const summary = useAsync(
    (signal) => api.get<AnalyticsSummary>('/v1/analytics/summary', { signal }),
    [],
  );
  const ai = useAsync((signal) => api.get<AiStatus>('/v1/admin/ai/status', { signal }), []);

  const s = summary.data;

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Campus overview</h2>
          <p className="page-head__subtitle">
            <span className="mono">{user?.workspace}</span> workspace ·{' '}
            {s ? `generated ${formatDateTime(s.scope.generatedAt)}` : 'loading…'}
          </p>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          {user && <WorkspaceTag workspace={user.workspace} />}
          <Link to="/admin/analytics" className="btn btn--primary">
            Full analytics
          </Link>
        </div>
      </div>

      {summary.error && (
        <div className="mb-5">
          <ErrorPane error={summary.error} onRetry={summary.reload} />
        </div>
      )}

      {!s && summary.loading && <SkeletonRows rows={3} />}

      {s && (
        <>
          <section className="section">
            <StatGrid>
              <StatTile
                label="Issues"
                value={formatCount(s.issues.total)}
                foot={`${formatCount(s.issues.open)} still open`}
                href="/admin/issues"
              />
              <StatTile
                label="Reports"
                value={formatCount(s.reports.total)}
                foot={`from ${formatCount(s.reports.distinctReporters)} students`}
              />
              <StatTile
                label="Awaiting validation"
                value={formatCount(s.reports.pending)}
                tone={s.reports.pending > 0 ? 'warning' : 'default'}
                foot="No verdict recorded yet"
              />
              <StatTile
                label="Overdue"
                value={formatCount(s.issues.overdue)}
                tone={s.issues.overdue > 0 ? 'danger' : 'default'}
                foot="Past their due date"
                href="/admin/issues?overdueOnly=true"
              />
              <StatTile
                label="Median resolution"
                value={formatHours(s.resolution.medianHours)}
                foot={
                  s.resolution.resolvedCount > 0
                    ? `Mean ${formatHours(s.resolution.averageHours)} over ${formatCount(s.resolution.resolvedCount)}`
                    : 'Nothing resolved yet'
                }
              />
              <StatTile
                label="Tokens outstanding"
                value={formatCount(s.tokens.credited - s.tokens.reversed)}
                foot={`${formatCount(s.tokens.credited)} credited · ${formatCount(s.tokens.reversed)} reversed`}
              />
            </StatGrid>
          </section>

          {s.reports.duplicatesLinked > 0 && (
            <div className="mb-5">
              <InlineAlert variant="info" title="Duplicate linking is working">
                {formatCount(s.reports.duplicatesLinked)} report
                {s.reports.duplicatesLinked === 1 ? ' was' : 's were'} attached to an existing repair
                ticket instead of creating a new one. Each of those reporters was still credited —
                reporting something already known is not a wasted effort.
              </InlineAlert>
            </div>
          )}

          <div className="grid-2">
            <Card
              title="Validation outcomes"
              subtitle="How reports have been decided so far."
              flush
            >
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    <Row label="Awaiting a verdict" value={s.reports.pending} />
                    <Row label="AI validated" value={s.reports.aiValidated} />
                    <Row label="Human validated" value={s.reports.humanValidated} />
                    <Row label="Valid duplicate" value={s.reports.duplicateValidated} />
                    <Row label="Rejected" value={s.reports.rejected} />
                    <Row label="Decided (all outcomes)" value={s.reports.decided} emphasised />
                  </tbody>
                </table>
              </div>
            </Card>

            <Card
              title="AI status"
              subtitle="What is actually configured on this deployment."
              action={
                <Link to="/admin/system" className="btn btn--secondary btn--sm">
                  Details
                </Link>
              }
              flush
            >
              {ai.error ? (
                <ErrorPane error={ai.error} onRetry={ai.reload} />
              ) : !ai.data ? (
                <SkeletonRows rows={3} />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <tbody>
                      <Row label="Provider" value={ai.data.provider} mono />
                      <Row label="Model" value={ai.data.model} mono />
                      <Row label="Model version" value={ai.data.modelVersion} mono />
                      <Row
                        label="Configured"
                        value={ai.data.configured ? 'Yes' : 'No'}
                        emphasised={!ai.data.configured}
                      />
                      <Row label="Analyses recorded" value={s.ai.analyses} />
                      <Row label="Needs human review" value={s.ai.needsReview} />
                      <Row label="Failed" value={s.ai.failed} />
                      <Row label="Disagreed with the student" value={s.ai.disagreements} />
                      <Row
                        label="Mean ranking score"
                        value={
                          s.ai.averageConfidence === null
                            ? '—'
                            : formatConfidence(s.ai.averageConfidence)
                        }
                        note={s.ai.confidenceNote}
                      />
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <section className="section">
            <Card
              title="Busiest locations"
              subtitle="Open issues per block. A place with many open problems is usually a place worth inspecting."
              flush
            >
              {s.byBlock.length === 0 ? (
                <EmptyPane icon="▦" title="No issues recorded" text="Breakdowns appear once issues exist." />
              ) : (
                <div className="table-wrap">
                  <table className="table table--interactive">
                    <thead>
                      <tr>
                        <th scope="col">Block</th>
                        <th scope="col" className="table__num">
                          Total
                        </th>
                        <th scope="col" className="table__num">
                          Open
                        </th>
                        <th scope="col" className="table__num">
                          Overdue
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.byBlock.slice(0, 8).map((row) => (
                        <tr key={row.blockId}>
                          <td>
                            <Link to={`/admin/issues?blockId=${row.blockId}`}>{row.blockName}</Link>
                          </td>
                          <td className="table__num">{row.total}</td>
                          <td className="table__num">{row.open}</td>
                          <td className="table__num">
                            {row.overdue > 0 ? <span className="amount--debit">{row.overdue}</span> : 0}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </section>

          {s.bySeverity.length > 0 && (
            <Card title="By severity" subtitle="The operational severity a person confirmed.">
              <div className="row row--wrap" style={{ gap: 'var(--space-3)' }}>
                {s.bySeverity.map((row) => (
                  <div key={row.severity} className="pill-stat">
                    <span className="pill-stat__value">{row.total}</span>
                    <span className="pill-stat__label">{humanise(row.severity)}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </>
  );
}

function Row({
  label,
  value,
  note,
  mono = false,
  emphasised = false,
}: {
  label: string;
  value: number | string;
  note?: string;
  mono?: boolean;
  emphasised?: boolean;
}) {
  return (
    <tr>
      <th scope="row" style={{ fontWeight: 500 }}>
        {label}
        {note && (
          <span className="small muted" style={{ display: 'block', fontWeight: 400 }}>
            {note}
          </span>
        )}
      </th>
      <td className={`table__num${emphasised ? ' strong' : ''}`}>
        <span className={mono ? 'mono' : undefined}>{typeof value === 'number' ? formatCount(value) : value}</span>
      </td>
    </tr>
  );
}
