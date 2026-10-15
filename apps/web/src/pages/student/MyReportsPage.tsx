/**
 * The student's own reports.
 *
 * §8 asks for a searchable, filterable list. Filtering happens CLIENT-SIDE here because the
 * endpoint returns the student's reports in one bounded page (`limit` max 100) and a student
 * will realistically have tens, not thousands. That is a deliberate difference from the HOD
 * issue list, which filters server-side — see IssuesPage for why.
 *
 * A student sees only their own reports. The backend enforces that (`/v1/reports/mine` scopes
 * to the session's user), so there is no ownership check here pretending to be security.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, query } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type { Block, Category, MyReport, Paginated } from '../../lib/types.js';
import { Card } from '../../components/data.js';
import { EmptyPane, ErrorPane, SkeletonRows } from '../../components/states.js';
import { DuplicateBadge, ValidationBadge } from '../../components/badges.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { ReportThumb } from '../../components/ReportThumb.js';

const VALIDATION_FILTERS = [
  { value: '', label: 'All reports' },
  { value: 'PENDING', label: 'Awaiting validation' },
  { value: 'AI_VALIDATED', label: 'AI validated' },
  { value: 'HUMAN_VALIDATED', label: 'Human validated' },
  { value: 'DUPLICATE_VALIDATED', label: 'Valid duplicate' },
  { value: 'REJECTED', label: 'Rejected' },
];

export function MyReportsPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch] = useState('');

  const reports = useAsync(
    (signal) => api.get<Paginated<MyReport>>(`/v1/reports/mine${query({ limit: 100 })}`, { signal }),
    [],
  );
  const blocks = useAsync((signal) => api.get<Paginated<Block>>('/v1/campus/blocks', { signal }), []);
  const categories = useAsync(
    (signal) => api.get<Paginated<Category>>('/v1/campus/categories', { signal }),
    [],
  );

  const blockName = (id: string) => blocks.data?.items.find((b) => b.id === id)?.officialName ?? '—';
  const categoryName = (id: string) => categories.data?.items.find((c) => c.id === id)?.name ?? '—';

  const filtered = useMemo(() => {
    const items = reports.data?.items ?? [];
    const needle = search.trim().toLowerCase();
    return items.filter((report) => {
      if (statusFilter && report.validationStatus !== statusFilter) return false;
      if (categoryFilter && report.selectedCategoryId !== categoryFilter) return false;
      if (needle) {
        const haystack = `${categoryName(report.selectedCategoryId)} ${blockName(report.blockId)}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
    // `blockName`/`categoryName` read from the same state these depend on, so the
    // dependency list below is complete.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reports.data, statusFilter, categoryFilter, search, blocks.data, categories.data]);

  const hasAny = (reports.data?.items.length ?? 0) > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">My reports</h2>
          <p className="page-head__subtitle">
            Everything you have reported, and where each one stands.
          </p>
        </div>
        <Link to="/student/report" className="btn btn--primary">
          📷 New report
        </Link>
      </div>

      {reports.error ? (
        <ErrorPane error={reports.error} onRetry={reports.reload} />
      ) : reports.loading && !reports.data ? (
        <SkeletonRows rows={5} />
      ) : !hasAny ? (
        <Card>
          <EmptyPane
            icon="📷"
            title="You have not reported anything yet"
            text="Reports you submit appear here with their status, the AI's assessment, and any tokens earned."
            action={
              <Link to="/student/report" className="btn btn--primary">
                Report your first issue
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="filter-bar">
            <div className="field">
              <label className="field__label" htmlFor="filter-search">
                Search
              </label>
              <input
                id="filter-search"
                className="input"
                type="search"
                placeholder="Block or category…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="filter-status">
                Validation
              </label>
              <select
                id="filter-status"
                className="select"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                {VALIDATION_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="filter-category">
                Category
              </label>
              <select
                id="filter-category"
                className="select"
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
              >
                <option value="">All categories</option>
                {(categories.data?.items ?? []).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </div>
            <span className="small muted" style={{ marginLeft: 'auto', paddingBottom: 8 }}>
              {filtered.length} of {reports.data?.total ?? 0}
            </span>
          </div>

          {filtered.length === 0 ? (
            <Card>
              <EmptyPane
                icon="⌕"
                title="No reports match these filters"
                text="Try clearing the filters to see everything you have submitted."
                action={
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => {
                      setStatusFilter('');
                      setCategoryFilter('');
                      setSearch('');
                    }}
                  >
                    Clear filters
                  </button>
                }
              />
            </Card>
          ) : (
            <Card flush>
              <div>
                {filtered.map((report) => (
                  <Link key={report.id} to={`/student/reports/${report.id}`} className="report-row">
                    <ReportThumb reportId={report.id} hasEvidence={report.hasEvidence} />
                    <div className="report-row__main">
                      <p className="report-row__title">{categoryName(report.selectedCategoryId)}</p>
                      <p className="report-row__meta">
                        <span>{blockName(report.blockId)}</span>
                        <span>·</span>
                        <span>{formatDateTime(report.submittedAt)}</span>
                        <span>·</span>
                        <span>{formatRelative(report.submittedAt)}</span>
                      </p>
                    </div>
                    <div className="report-row__side">
                      {report.tokensAwarded > 0 && (
                        <span className="badge badge--resolved">+{report.tokensAwarded}</span>
                      )}
                      {report.duplicateMatchStatus === 'LINKED' && (
                        <DuplicateBadge status={report.duplicateMatchStatus} />
                      )}
                      <ValidationBadge status={report.validationStatus} />
                    </div>
                  </Link>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </>
  );
}
