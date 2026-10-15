/**
 * HOD overview — the operational queue at a glance (§10).
 *
 * THIS IS A WORK QUEUE, NOT A REPORT. The brief is explicit that "the HOD is the operational
 * owner, not an analyst", so the page leads with what needs a decision today — overdue,
 * unclaimed, submitted — and keeps the decorative charts for the admin side.
 *
 * The counts come from `/v1/analytics/summary`, which is aggregated in SQL over the whole
 * workspace for a HOD caller. Nothing is estimated from a page of results.
 *
 * There is no "analytics" chart here on purpose. A HOD deciding what to action next does not
 * need a weekly trend line; they need the four numbers above and a way into the list.
 */

import { Link } from 'react-router-dom';
import { api, query } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type { AnalyticsSummary, Issue, Paginated, ReviewQueueItem } from '../../lib/types.js';
import { Card, StatGrid, StatTile } from '../../components/data.js';
import { EmptyPane, ErrorPane, InlineAlert, SkeletonRows } from '../../components/states.js';
import { OverdueBadge, SeverityBadge, StatusBadge } from '../../components/badges.js';
import { formatCount, formatElapsed, formatHours } from '../../lib/format.js';
import { useCurrentUser } from '../../lib/session.js';
import { useCampusLookup, type CampusLookup } from '../../lib/campus.js';

export function HodDashboard() {
  const user = useCurrentUser();
  const campus = useCampusLookup();

  const summary = useAsync(
    (signal) => api.get<AnalyticsSummary>('/v1/analytics/summary', { signal }),
    [],
  );
  /**
   * `/v1/issues` orders by `created_at DESC` and offers no sort parameter. Rather than claim
   * an ordering the API does not provide, a wider page is fetched and ranked by due date
   * here, and the card says exactly which set was ranked.
   */
  const overdue = useAsync(
    (signal) =>
      api.get<Paginated<Issue>>(`/v1/issues${query({ overdueOnly: true, limit: 25 })}`, { signal }),
    [],
  );
  const unclaimed = useAsync(
    (signal) =>
      api.get<Paginated<Issue>>(`/v1/issues${query({ status: 'SUBMITTED', limit: 5 })}`, { signal }),
    [],
  );
  const reviewQueue = useAsync(
    (signal) => api.get<{ count: number; items: ReviewQueueItem[] }>('/v1/admin/review-queue', { signal }),
    [],
  );

  const s = summary.data;

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Department queue</h2>
          <p className="page-head__subtitle">
            Signed in as {user.displayName} · every issue visible here is in your workspace only.
          </p>
        </div>
        <Link to="/hod/issues" className="btn btn--primary">
          Open issue queue
        </Link>
      </div>

      {summary.error && (
        <div className="mb-5">
          <ErrorPane error={summary.error} onRetry={summary.reload} />
        </div>
      )}

      <section className="section">
        <StatGrid>
          <StatTile
            label="Awaiting approval"
            value={s ? formatCount(s.issues.submitted) : null}
            tone={s && s.issues.submitted > 0 ? 'warning' : 'default'}
            foot="Reported, not yet approved"
            href="/hod/issues?status=SUBMITTED"
          />
          <StatTile
            label="In progress"
            value={s ? formatCount(s.issues.inProgress) : null}
            foot="Work started"
            href="/hod/issues?status=IN_PROGRESS"
          />
          <StatTile
            label="Overdue"
            value={s ? formatCount(s.issues.overdue) : null}
            tone={s && s.issues.overdue > 0 ? 'danger' : 'default'}
            foot="Past their due date"
            href="/hod/issues?overdueOnly=true"
          />
          <StatTile
            label="Unclaimed"
            value={s ? formatCount(s.issues.unclaimed) : null}
            foot="Nobody has taken these"
          />
          <StatTile
            label="Resolved"
            value={s ? formatCount(s.issues.resolved) : null}
            tone="success"
            foot="Closed with a completion note"
          />
          <StatTile
            label="Median resolution"
            value={s ? formatHours(s.resolution.medianHours) : null}
            foot={
              s && s.resolution.resolvedCount > 0
                ? `Across ${formatCount(s.resolution.resolvedCount)} resolved issues`
                : 'Nothing resolved yet'
            }
          />
        </StatGrid>
      </section>

      {reviewQueue.data && reviewQueue.data.count > 0 && (
        <div className="mb-5">
          <InlineAlert variant="warning" title={`${reviewQueue.data.count} report(s) need a human decision`}>
            The AI flagged these — usually because its prediction disagreed with the student's choice,
            or because it was not confident enough to accept on its own. Nothing is auto-accepted.
            {' '}
            <Link to="/hod/review">Open the review queue →</Link>
          </InlineAlert>
        </div>
      )}

      <div className="grid-2">
        <Card
          title="Overdue issues"
          subtitle="Earliest due date first, ranked within the 25 most recent overdue issues."
          action={
            <Link to="/hod/issues?overdueOnly=true" className="btn btn--secondary btn--sm">
              View all
            </Link>
          }
          flush
        >
          {overdue.loading && !overdue.data ? (
            <SkeletonRows rows={3} />
          ) : overdue.error ? (
            <ErrorPane error={overdue.error} onRetry={overdue.reload} />
          ) : (overdue.data?.items.length ?? 0) === 0 ? (
            <EmptyPane
              icon="✓"
              title="Nothing is overdue"
              text="Every open issue is still inside its due date."
            />
          ) : (
            <IssueMiniList
              campus={campus}
              issues={[...overdue.data!.items]
                .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
                .slice(0, 5)}
            />
          )}
        </Card>

        <Card
          title="Waiting for approval"
          subtitle="Newly reported, awaiting a decision from you."
          action={
            <Link to="/hod/issues?status=SUBMITTED" className="btn btn--secondary btn--sm">
              View all
            </Link>
          }
          flush
        >
          {unclaimed.loading && !unclaimed.data ? (
            <SkeletonRows rows={3} />
          ) : unclaimed.error ? (
            <ErrorPane error={unclaimed.error} onRetry={unclaimed.reload} />
          ) : (unclaimed.data?.items.length ?? 0) === 0 ? (
            <EmptyPane icon="✓" title="Nothing is waiting" text="No issue is sitting at SUBMITTED." />
          ) : (
            <IssueMiniList issues={unclaimed.data!.items} campus={campus} />
          )}
        </Card>
      </div>

      <section className="section">
        <Card title="Where the problems are" subtitle="Open issues per block, from live data.">
          {!s || s.byBlock.length === 0 ? (
            <EmptyPane icon="▦" title="No issues recorded" text="Breakdowns appear once issues exist." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Block</th>
                    <th scope="col" className="table__num">
                      Open
                    </th>
                    <th scope="col" className="table__num">
                      Overdue
                    </th>
                    <th scope="col" className="table__num">
                      Resolved
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.byBlock.map((row) => (
                    <tr key={row.blockId}>
                      <td>
                        <Link to={`/hod/issues?blockId=${row.blockId}`}>{row.blockName}</Link>
                      </td>
                      <td className="table__num">{row.open}</td>
                      <td className="table__num">
                        {row.overdue > 0 ? (
                          <span className="amount--debit">{row.overdue}</span>
                        ) : (
                          0
                        )}
                      </td>
                      <td className="table__num">{row.resolved}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </>
  );
}

/** The compact list shared by the two panels above. Names come from the lookup, never invented. */
function IssueMiniList({ issues, campus }: { issues: Issue[]; campus: CampusLookup }) {
  return (
    <div>
      {issues.map((issue) => (
        <Link key={issue.id} to={`/hod/issues/${issue.id}`} className="report-row">
          <div className="report-row__main">
            <p className="report-row__title">
              <span className="mono">{issue.publicReference}</span> · {campus.categoryName(issue.categoryId)}
            </p>
            <p className="report-row__meta">
              <span>{campus.blockName(issue.blockId)}</span>
              <span>·</span>
              <span>{issue.reportCount} report{issue.reportCount === 1 ? '' : 's'}</span>
              <span>·</span>
              <span>{formatElapsed(issue.createdAt)} old</span>
            </p>
          </div>
          <div className="report-row__side">
            {issue.overdue && <OverdueBadge />}
            {issue.severity && <SeverityBadge severity={issue.severity} />}
            <StatusBadge status={issue.status} />
          </div>
        </Link>
      ))}
    </div>
  );
}
