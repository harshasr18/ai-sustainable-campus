/**
 * The operational issue queue (§10) — shared by HOD and ADMIN.
 *
 * FILTERING IS SERVER-SIDE, AND THE FILTERS ARE THE ONES THE API ACTUALLY HAS.
 * `ListIssuesQuerySchema` accepts status, blockId, categoryId, claimedByUserId, overdueOnly,
 * limit and offset. §12 asks for filtering by severity and date range too; the API does not
 * support either yet (audit gap G4). Rather than fake a severity filter by paging through
 * everything in the browser — which would show a wrong total for any workspace with more
 * issues than one page — this page offers only the filters the server honours, and says so
 * where the missing ones would sit. `docs/PHASE3_AUDIT.md` records the gap.
 *
 * THE URL IS THE STATE. Filters live in the query string, so the HOD dashboard's
 * "View all →" link with `?status=SUBMITTED` lands on a pre-filtered list, and a filtered view
 * can be sent to a colleague. A filter held in component state would break both.
 *
 * ROW ACTIONS ARE LINKS, NOT BUTTONS. Every lifecycle change happens on the detail page,
 * against the version the page loaded — that is what makes the double-claim guard in the
 * domain layer meaningful. An inline "Resolve" button on a list row would be acting on a
 * possibly-stale version.
 */

import { Link, useSearchParams } from 'react-router-dom';
import { api, query } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type { Issue, Paginated } from '../../lib/types.js';
import { Card, Pagination } from '../../components/data.js';
import { EmptyPane, ErrorPane, InlineAlert, SkeletonRows } from '../../components/states.js';
import { OverdueBadge, SeverityBadge, StatusBadge } from '../../components/badges.js';
import { formatCount, formatDateTime, formatElapsed } from '../../lib/format.js';
import { useCampusLookup } from '../../lib/campus.js';
import { useSession } from '../../lib/session.js';

const PAGE_SIZE = 25;

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Any status' },
  { value: 'SUBMITTED', label: 'Awaiting approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'DUPLICATE', label: 'Merged (duplicate)' },
];

export function IssuesPage() {
  const [params, setParams] = useSearchParams();
  const campus = useCampusLookup();
  const { user } = useSession();

  const status = params.get('status') ?? '';
  const blockId = params.get('blockId') ?? '';
  const categoryId = params.get('categoryId') ?? '';
  const claimedBy = params.get('claimedByUserId') ?? '';
  const overdueOnly = params.get('overdueOnly') === 'true';
  const offset = Number(params.get('offset') ?? 0) || 0;

  /** Every filter change resets to page one — otherwise you land on an empty page 4. */
  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    if (!('offset' in patch)) next.delete('offset');
    setParams(next, { replace: true });
  }

  const issues = useAsync(
    (signal) =>
      api.get<Paginated<Issue>>(
        `/v1/issues${query({
          status: status || undefined,
          blockId: blockId || undefined,
          categoryId: categoryId || undefined,
          claimedByUserId: claimedBy || undefined,
          overdueOnly: overdueOnly ? true : undefined,
          limit: PAGE_SIZE,
          offset,
        })}`,
        { signal },
      ),
    [status, blockId, categoryId, claimedBy, overdueOnly, offset],
  );

  const items = issues.data?.items ?? [];
  const total = issues.data?.total ?? 0;
  const anyFilter = Boolean(status || blockId || categoryId || claimedBy || overdueOnly);

  // The queue URL differs by role so a link shared between an admin and an HOD stays valid
  // for the person who opens it.
  const base = user?.role === 'ADMIN' ? '/admin/issues' : '/hod/issues';
  const detailHref = (issueId: string) => `${base}/${issueId}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Issue queue</h2>
          <p className="page-head__subtitle">
            {issues.data
              ? `${formatCount(total)} issue${total === 1 ? '' : 's'}${anyFilter ? ' matching these filters' : ''}.`
              : 'Loading the queue…'}
          </p>
        </div>
        <Link to="/hod/review" className="btn btn--secondary">
          Review queue
        </Link>
      </div>

      <div className="filter-bar">
        <div className="field">
          <label className="field__label" htmlFor="f-status">
            Status
          </label>
          <select
            id="f-status"
            className="select"
            value={status}
            onChange={(event) => update({ status: event.target.value })}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="f-block">
            Block
          </label>
          <select
            id="f-block"
            className="select"
            value={blockId}
            onChange={(event) => update({ blockId: event.target.value })}
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
          <label className="field__label" htmlFor="f-category">
            Category
          </label>
          <select
            id="f-category"
            className="select"
            value={categoryId}
            onChange={(event) => update({ categoryId: event.target.value })}
          >
            <option value="">All categories</option>
            {campus.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="f-claimed">
            Assignment
          </label>
          <select
            id="f-claimed"
            className="select"
            value={claimedBy}
            onChange={(event) => update({ claimedByUserId: event.target.value })}
          >
            <option value="">Anyone</option>
            {user && <option value={user.id}>Claimed by me</option>}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="f-overdue">
            Due date
          </label>
          <select
            id="f-overdue"
            className="select"
            value={overdueOnly ? 'true' : ''}
            onChange={(event) => update({ overdueOnly: event.target.value || null })}
          >
            <option value="">Any</option>
            <option value="true">Overdue only</option>
          </select>
        </div>

        {anyFilter && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ marginBottom: 6 }}
            onClick={() =>
              update({
                status: null,
                blockId: null,
                categoryId: null,
                claimedByUserId: null,
                overdueOnly: null,
              })
            }
          >
            Clear filters
          </button>
        )}
      </div>

      <InlineAlert variant="info" title="Filters the API does not support yet">
        Severity and date-range filtering are specified in §12 but not implemented in{' '}
        <code className="mono">ListIssuesQuerySchema</code> — recorded as gap G4 in the audit. They are
        deliberately absent rather than approximated in the browser, which would report a wrong total.
      </InlineAlert>

      <Card flush>
        {issues.error ? (
          <ErrorPane error={issues.error} onRetry={issues.reload} />
        ) : issues.loading && !issues.data ? (
          <SkeletonRows rows={6} />
        ) : items.length === 0 ? (
          <EmptyPane
            icon={anyFilter ? '⌕' : '✓'}
            title={anyFilter ? 'Nothing matches these filters' : 'The queue is empty'}
            text={
              anyFilter
                ? 'Try widening the filters, or clear them to see the whole queue.'
                : 'No issue has been reported in this workspace yet.'
            }
            action={
              anyFilter ? (
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() =>
                    update({
                      status: null,
                      blockId: null,
                      categoryId: null,
                      claimedByUserId: null,
                      overdueOnly: null,
                    })
                  }
                >
                  Clear filters
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table table--interactive">
                <thead>
                  <tr>
                    <th scope="col">Reference</th>
                    <th scope="col">Problem</th>
                    <th scope="col">Location</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Status</th>
                    <th scope="col">Assigned</th>
                    <th scope="col" className="table__num">
                      Reports
                    </th>
                    <th scope="col">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((issue) => (
                    <tr key={issue.id}>
                      <td>
                        <Link to={detailHref(issue.id)} className="mono">
                          {issue.publicReference}
                        </Link>
                        <div className="small muted">
                          {formatElapsed(issue.createdAt)} old
                        </div>
                      </td>
                      <td>
                        <Link to={detailHref(issue.id)}>{issue.title}</Link>
                        <div className="small muted">{campus.categoryName(issue.categoryId)}</div>
                      </td>
                      <td>{campus.blockName(issue.blockId)}</td>
                      <td>
                        {issue.severity ? (
                          <SeverityBadge severity={issue.severity} />
                        ) : (
                          <span className="muted small">Not set</span>
                        )}
                      </td>
                      <td>
                        <StatusBadge status={issue.status} />
                      </td>
                      <td className="small">
                        {issue.claimedByDisplayName ?? <span className="muted">Unclaimed</span>}
                      </td>
                      <td className="table__num">
                        {issue.reportCount > 1 ? (
                          <span className="badge badge--progress">{issue.reportCount}</span>
                        ) : (
                          issue.reportCount
                        )}
                      </td>
                      <td className="nowrap small">
                        {issue.status === 'RESOLVED' ? (
                          <span className="muted">Closed</span>
                        ) : issue.overdue ? (
                          // `OverdueBadge` takes the elapsed time, not the due date: it prints
                          // how late the issue is, and the "overdue" flag itself was computed
                          // server-side from the configured threshold.
                          <OverdueBadge elapsed={formatElapsed(issue.dueAt)} />
                        ) : (
                          formatDateTime(issue.dueAt)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={total}
              limit={PAGE_SIZE}
              offset={offset}
              onChange={(next) => update({ offset: String(next) })}
              busy={issues.refreshing}
            />
          </>
        )}
      </Card>
    </>
  );
}
