/**
 * Analytics (§12).
 *
 * TWO RULES SHAPE EVERY CHART ON THIS PAGE.
 *
 * 1. NO FABRICATED NUMBERS. Every series is a real `count(*)` or `avg()` over database rows,
 *    returned by `GET /v1/analytics/summary`. There is no sample dataset behind this page, no
 *    placeholder series shown while loading, and no "demo data" toggled on. When the workspace
 *    has no data the charts render an empty state that says so.
 *
 * 2. A GAP IS NOT A ZERO. The weekly series always contains twelve buckets because the server
 *    generates the full span and left-joins the counts, so a week with no reports is a real 0
 *    rather than a missing point — but a MEDIAN resolution time with nothing resolved is
 *    `null`, and that renders as "—", never as "0h".
 *
 * THE CHARTS ARE DELIBERATELY FEW. §12 asks for filtering and trends; it also warns against
 * decorative dashboards. A weekly volume line, a category breakdown and a severity split is
 * enough to answer "is anything getting worse, and where".
 */

import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, query } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type { AnalyticsSummary } from '../../lib/types.js';
import { Card, StatGrid, StatTile } from '../../components/data.js';
import { EmptyPane, ErrorPane, InlineAlert, SkeletonRows } from '../../components/states.js';
import { formatCount, formatConfidence, formatHours, humanise } from '../../lib/format.js';
import { useCampusLookup } from '../../lib/campus.js';

/** Trailing windows offered to the operator. `null` means all time. */
const WINDOWS = [
  { value: '', label: 'All time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
];

export function AnalyticsPage() {
  const campus = useCampusLookup();

  const [sinceDays, setSinceDays] = useState('');
  const [blockId, setBlockId] = useState('');
  const [categoryId, setCategoryId] = useState('');

  const summary = useAsync(
    (signal) =>
      api.get<AnalyticsSummary>(
        `/v1/analytics/summary${query({
          sinceDays: sinceDays || undefined,
          blockId: blockId || undefined,
          categoryId: categoryId || undefined,
        })}`,
        { signal },
      ),
    [sinceDays, blockId, categoryId],
  );

  const s = summary.data;
  const filtered = Boolean(sinceDays || blockId || categoryId);

  /** Recharts wants a plain array of plain values; the axis label is the week's start date. */
  const weekly = (s?.reportsByWeek ?? []).map((point) => ({
    week: new Date(point.weekStart).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    Reports: point.total,
    Decided: point.decided,
    Duplicates: point.duplicates,
  }));

  const categories = (s?.byCategory ?? []).slice(0, 10).map((row) => ({
    name: row.categoryName,
    Open: row.open,
    Resolved: row.resolved,
  }));

  const hasAnyData = (s?.reports.total ?? 0) > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Analytics</h2>
          <p className="page-head__subtitle">
            Every figure here is aggregated by the server from real records.
            {s && (
              <>
                {' '}
                Scope: <span className="mono">{s.scope.workspace}</span> workspace,{' '}
                {s.scope.audience === 'OWN_REPORTS' ? 'your own reports' : 'all campus activity'}.
              </>
            )}
          </p>
        </div>
      </div>

      <div className="filter-bar">
        <div className="field">
          <label className="field__label" htmlFor="a-window">
            Period
          </label>
          <select
            id="a-window"
            className="select"
            value={sinceDays}
            onChange={(event) => setSinceDays(event.target.value)}
          >
            {WINDOWS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="a-block">
            Block
          </label>
          <select
            id="a-block"
            className="select"
            value={blockId}
            onChange={(event) => setBlockId(event.target.value)}
          >
            <option value="">All blocks</option>
            {campus.blocks.map((block) => (
              <option key={block.id} value={block.id}>
                {block.officialName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="a-category">
            Category
          </label>
          <select
            id="a-category"
            className="select"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            <option value="">All categories</option>
            {campus.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
        {filtered && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ marginBottom: 6 }}
            onClick={() => {
              setSinceDays('');
              setBlockId('');
              setCategoryId('');
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {summary.error ? (
        <ErrorPane error={summary.error} onRetry={summary.reload} />
      ) : !s ? (
        <SkeletonRows rows={6} />
      ) : (
        <>
          <section className="section">
            <StatGrid>
              <StatTile label="Reports" value={formatCount(s.reports.total)} foot="In this scope" />
              <StatTile label="Issues" value={formatCount(s.issues.total)} foot={`${formatCount(s.issues.open)} open`} />
              <StatTile
                label="Median resolution"
                value={formatHours(s.resolution.medianHours)}
                foot={
                  s.resolution.resolvedCount > 0
                    ? `Mean ${formatHours(s.resolution.averageHours)}`
                    : 'Nothing resolved in this scope'
                }
              />
              <StatTile
                label="Median time to first action"
                value={formatHours(s.resolution.averageFirstActionHours)}
                foot="Submission to approval"
              />
              <StatTile
                label="Duplicate-linked"
                value={formatCount(s.reports.duplicatesLinked)}
                foot="Reports merged into an existing ticket"
              />
              <StatTile
                label="Awaiting a verdict"
                value={formatCount(s.reports.pending)}
                tone={s.reports.pending > 0 ? 'warning' : 'default'}
              />
            </StatGrid>
          </section>

          {!hasAnyData ? (
            <Card>
              <EmptyPane
                icon="▤"
                title="No reports in this scope"
                text="Charts stay empty until real reports exist. Nothing is filled in with example data."
              />
            </Card>
          ) : (
            <>
              <Card
                title="Reports per week"
                subtitle="The last twelve weeks. A week with no reports is a true zero — the span is generated by the server, so there are no hidden gaps."
              >
                <div className="chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={weekly} margin={{ top: 8, right: 16, bottom: 8, left: -12 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="week" tick={{ fontSize: 12 }} stroke="var(--text-muted)" />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fontSize: 12 }}
                        stroke="var(--text-muted)"
                        width={44}
                      />
                      <Tooltip
                        contentStyle={{
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          fontSize: 13,
                        }}
                      />
                      <Legend />
                      <Line type="monotone" dataKey="Reports" stroke="var(--green-600)" strokeWidth={2} dot={{ r: 3 }} />
                      <Line type="monotone" dataKey="Decided" stroke="var(--teal-600)" strokeWidth={2} dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="small muted mt-3 mb-0">
                  "Decided" counts reports that have received any verdict, so the gap between the two
                  lines is the backlog of undecided reports.
                </p>
              </Card>

              <Card
                title="Open and resolved by category"
                subtitle="The ten largest categories in this scope."
              >
                {categories.length === 0 ? (
                  <EmptyPane icon="▦" title="Nothing to break down" text="No issues in this scope." />
                ) : (
                  <div className="chart" style={{ height: 320 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={categories} margin={{ top: 8, right: 16, bottom: 8, left: -12 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis
                          dataKey="name"
                          tick={{ fontSize: 11 }}
                          stroke="var(--text-muted)"
                          interval={0}
                          angle={-20}
                          textAnchor="end"
                          height={70}
                        />
                        <YAxis
                          allowDecimals={false}
                          tick={{ fontSize: 12 }}
                          stroke="var(--text-muted)"
                          width={44}
                        />
                        <Tooltip
                          contentStyle={{
                            borderRadius: 8,
                            border: '1px solid var(--border)',
                            fontSize: 13,
                          }}
                        />
                        <Legend />
                        <Bar dataKey="Open" stackId="a" fill="var(--status-submitted-border)" radius={[0, 0, 0, 0]} />
                        <Bar dataKey="Resolved" stackId="a" fill="var(--green-500)" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Card>
            </>
          )}

          <div className="grid-2">
            <Card title="Severity mix" subtitle="Operational severity, as confirmed by a person.">
              {s.bySeverity.length === 0 ? (
                <EmptyPane
                  icon="—"
                  title="No severity has been recorded"
                  text="Severity is confirmed by an HOD from an issue's detail page. Until then every issue is unset — which is shown here honestly rather than guessed at."
                />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Severity</th>
                        <th scope="col" className="table__num">
                          Issues
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.bySeverity.map((row) => (
                        <tr key={row.severity}>
                          <td>{humanise(row.severity)}</td>
                          <td className="table__num">{row.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card title="AI activity" subtitle="What the model has been asked to do, and how it went.">
              {s.ai.analyses === 0 ? (
                <EmptyPane
                  icon="○"
                  title="No analyses have been recorded"
                  text="This deployment has no AI provider configured, so nothing has been analysed. These figures stay at zero rather than showing an illustrative example."
                />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <tbody>
                      <tr>
                        <th scope="row">Analyses</th>
                        <td className="table__num">{s.ai.analyses}</td>
                      </tr>
                      <tr>
                        <th scope="row">Succeeded</th>
                        <td className="table__num">{s.ai.succeeded}</td>
                      </tr>
                      <tr>
                        <th scope="row">Needs human review</th>
                        <td className="table__num">{s.ai.needsReview}</td>
                      </tr>
                      <tr>
                        <th scope="row">Failed</th>
                        <td className="table__num">{s.ai.failed}</td>
                      </tr>
                      <tr>
                        <th scope="row">Disagreed with the student</th>
                        <td className="table__num">{s.ai.disagreements}</td>
                      </tr>
                      <tr>
                        <th scope="row">
                          Mean ranking score
                          <span className="small muted" style={{ display: 'block', fontWeight: 400 }}>
                            {s.ai.confidenceNote}
                          </span>
                        </th>
                        <td className="table__num">
                          {s.ai.averageConfidence === null ? '—' : formatConfidence(s.ai.averageConfidence)}
                        </td>
                      </tr>
                      <tr>
                        <th scope="row">Mean latency</th>
                        <td className="table__num">
                          {s.ai.averageLatencyMs === null ? '—' : `${Math.round(s.ai.averageLatencyMs)} ms`}
                        </td>
                      </tr>
                      {s.ai.models.length > 0 && (
                        <tr>
                          <th scope="row">Models used</th>
                          <td className="table__num mono small">
                            {s.ai.models.map((m) => m.model).join(', ')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <div className="mt-5">
            <InlineAlert variant="info" title="About the token figures">
              The ledger has no block or category dimension — a credit is for a report, not for a
              place — so token totals are always {s.tokens.scope === 'OWN_LEDGER' ? 'your own' : 'workspace-wide'}
              {' '}even when the rest of this page is filtered. They are labelled that way rather than
              presented as if the filter applied: {formatCount(s.tokens.credited)} credited,{' '}
              {formatCount(s.tokens.reversed)} reversed, across{' '}
              {formatCount(s.tokens.creditCount)} credit entries and{' '}
              {formatCount(s.tokens.reversalCount)} reversals.
            </InlineAlert>
          </div>
        </>
      )}
    </>
  );
}
