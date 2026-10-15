/**
 * Student overview.
 *
 * EVERY NUMBER ON THIS PAGE IS COMPUTED FROM REAL API RESPONSES. There is no sample data,
 * no fallback constant and no placeholder count — §6 of the brief is explicit ("Do not
 * hardcode sample numbers"), and a dashboard that shows a confident "12" before the first
 * fetch resolves is exactly the failure that rule exists to prevent.
 *
 * WHERE THE COUNTS COME FROM. `/v1/analytics/summary` aggregates in SQL and scopes itself to
 * the calling session, so for a STUDENT it returns counts over that student's own reports —
 * exact, not a count of whatever happened to fit in the first page. An earlier draft counted
 * a 100-row page and would have silently under-reported a student with more reports than
 * that; the endpoint exists so the numbers can be trusted. `issues.*` is scoped to issues the
 * student filed a report on, so a student never learns how many tickets exist campus-wide.
 *
 * The "Report an issue" action is the first thing in the DOM and full-width on small
 * screens, per §6 ("Make the most important action easy to find on a mobile screen").
 */

import { Link } from 'react-router-dom';
import { api, query } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type {
  AnalyticsSummary,
  Block,
  Category,
  MyReport,
  Paginated,
  TokenBalance,
} from '../../lib/types.js';
import { StatGrid, StatTile, Card } from '../../components/data.js';
import { EmptyPane, ErrorPane, InlineAlert, SkeletonRows } from '../../components/states.js';
import { ValidationBadge, DuplicateBadge, StatusBadge } from '../../components/badges.js';
import { formatCount, formatDateTime, formatElapsed, formatRelative } from '../../lib/format.js';
import { useCurrentUser } from '../../lib/session.js';
import { ReportThumb } from '../../components/ReportThumb.js';

export function StudentDashboard() {
  const user = useCurrentUser();

  // Three requests, run in parallel. Each has its own error state so one failing panel does
  // not blank the whole page — a student whose token request times out should still see
  // their reports.
  const reports = useAsync(
    (signal) => api.get<Paginated<MyReport>>(`/v1/reports/mine${query({ limit: 5 })}`, { signal }),
    [],
  );
  const analytics = useAsync(
    (signal) => api.get<AnalyticsSummary>('/v1/analytics/summary', { signal }),
    [],
  );
  const balance = useAsync((signal) => api.get<TokenBalance>('/v1/tokens/balance', { signal }), []);
  const blocks = useAsync((signal) => api.get<Paginated<Block>>('/v1/campus/blocks', { signal }), []);
  const categories = useAsync(
    (signal) => api.get<Paginated<Category>>('/v1/campus/categories', { signal }),
    [],
  );

  const blockName = (blockId: string) =>
    blocks.data?.items.find((block) => block.id === blockId)?.officialName ?? 'Unknown block';
  const categoryName = (categoryId: string) =>
    categories.data?.items.find((category) => category.id === categoryId)?.name ?? 'Unknown category';

  const items = reports.data?.items ?? [];
  const summary = analytics.data;

  /**
   * The tiles read straight off the server aggregate. "Awaiting review" is reports still at
   * PENDING validation — the ones where the student is genuinely waiting on someone else.
   */
  const awaitingReview = summary?.reports.pending ?? null;
  const validated = summary?.reports.decided ?? null;
  const tokensFromReports = summary?.tokens.credited ?? null;

  const anyLoading = reports.loading || analytics.loading || balance.loading;
  const loadError = analytics.error ?? balance.error;

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Hello, {user.displayName.split(' ')[0]}</h2>
          <p className="page-head__subtitle">
            Report a fault on campus and track it until it is fixed. Every validated report earns
            {' '}
            <strong>10 tokens</strong>.
          </p>
        </div>
      </div>

      {/* Primary action first in the DOM, so it is the first thing a screen reader reaches
          and the most prominent thing on a small screen. */}
      <Link
        to="/student/report"
        className="btn btn--primary btn--lg btn--block"
        style={{ marginBottom: 'var(--space-5)' }}
      >
        📷 Report an issue
      </Link>

      {loadError && (
        <div className="mb-4">
          <ErrorPane error={loadError} onRetry={analytics.reload} />
        </div>
      )}

      {balance.data && balance.data.lifetimeReversed > 0 && (
        <div className="mb-4">
          <InlineAlert variant="warning" title="Some tokens were reversed">
            {formatCount(balance.data.lifetimeReversed)} tokens were reversed by staff. See your
            token history for the reason recorded against each reversal.
          </InlineAlert>
        </div>
      )}

      <section className="section">
        <StatGrid>
          <StatTile
            label="Tokens"
            value={balance.data ? formatCount(balance.data.balance) : null}
            tone="accent"
            foot={
              balance.data
                ? `${formatCount(balance.data.lifetimeCredited)} credited · ${formatCount(
                    balance.data.lifetimeReversed,
                  )} reversed`
                : 'Loading…'
            }
            href="/student/tokens"
          />
          <StatTile
            label="My reports"
            value={summary ? formatCount(summary.reports.total) : null}
            foot="All time"
            href="/student/reports"
          />
          <StatTile
            label="Awaiting review"
            value={awaitingReview === null ? null : formatCount(awaitingReview)}
            tone={awaitingReview !== null && awaitingReview > 0 ? 'warning' : 'default'}
            foot="Not yet validated"
          />
          <StatTile
            label="Validated"
            value={validated === null ? null : formatCount(validated)}
            foot={tokensFromReports === null ? undefined : `${formatCount(tokensFromReports)} tokens from reports`}
          />
        </StatGrid>
      </section>

      <section className="section">
        <Card
          title="Recent reports"
          subtitle="Your five most recent submissions."
          action={
            <Link to="/student/reports" className="btn btn--secondary btn--sm">
              View all
            </Link>
          }
          flush
        >
          {reports.loading && !reports.data ? (
            <SkeletonRows rows={3} />
          ) : reports.error ? (
            <ErrorPane error={reports.error} onRetry={reports.reload} />
          ) : !reports.data || reports.data.items.length === 0 ? (
            <EmptyPane
              icon="📷"
              title="No reports yet"
              text="When you spot something broken on campus, photograph it and report it. It takes about thirty seconds, and you earn tokens when the report is validated."
              action={
                <Link to="/student/report" className="btn btn--primary">
                  Report your first issue
                </Link>
              }
            />
          ) : (
            <div>
              {reports.data.items.map((report) => (
                <Link
                  key={report.id}
                  to={`/student/reports/${report.id}`}
                  className="report-row"
                >
                  <ReportThumb reportId={report.id} hasEvidence={report.hasEvidence} />
                  <div className="report-row__main">
                    <p className="report-row__title">{categoryName(report.selectedCategoryId)}</p>
                    <p className="report-row__meta">
                      <span>{blockName(report.blockId)}</span>
                      <span>·</span>
                      <span>{formatRelative(report.submittedAt)}</span>
                    </p>
                  </div>
                  <div className="report-row__side">
                    {report.tokensAwarded > 0 && (
                      <span className="badge badge--resolved">+{report.tokensAwarded}</span>
                    )}
                    <ValidationBadge status={report.validationStatus} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </section>

      {items.length > 0 && (
        <section className="section">
          <Card title="Latest status changes" subtitle="Where your reports stand right now." flush>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Submitted</th>
                    <th scope="col">Block</th>
                    <th scope="col">Validation</th>
                    <th scope="col">Duplicate check</th>
                  </tr>
                </thead>
                <tbody>
                  {items.slice(0, 6).map((report) => (
                    <tr key={report.id}>
                      <td>
                        <Link to={`/student/reports/${report.id}`}>{formatDateTime(report.submittedAt)}</Link>
                        <div className="small muted">{formatElapsed(report.submittedAt)} ago</div>
                      </td>
                      <td>{blockName(report.blockId)}</td>
                      <td>
                        <ValidationBadge status={report.validationStatus} />
                      </td>
                      <td>
                        <DuplicateBadge status={report.duplicateMatchStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      )}

      {anyLoading && !summary && <SkeletonRows rows={2} />}
    </>
  );
}
