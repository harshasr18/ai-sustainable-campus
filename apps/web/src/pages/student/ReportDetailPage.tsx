/**
 * A single report, from the student's side.
 *
 * §8 lists what the detail page must show: full authorized information, a status timeline, the
 * AI result where permitted, the duplicate/master-issue relationship, the token credit, and
 * the resolution note once complete.
 *
 * ON THE STATUS TIMELINE: the four-stage sequence the brief names (Submitted → Approved → In
 * progress → Resolved) is the ISSUE lifecycle, and it is rendered from the issue's real
 * status history — not from a hardcoded four-step template. The report ALSO has a validation
 * status and a duplicate-check status, which are separate vocabularies. Forcing those into
 * "step 2 of 4" would be inventing a state machine the backend does not have, which §8 warns
 * against ("If the backend has additional review states, display them accurately rather than
 * forcing every issue into this sequence").
 *
 * Students never see a control that changes status. Those are HOD operations, enforced
 * server-side; this page has no mutation of any kind.
 */

import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type {
  Block,
  Category,
  IssueDetailResponse,
  IssueHistoryEntry,
  Paginated,
  ReportAnalysisResponse,
  ReportDetail,
  Spot,
  TokenTransaction,
} from '../../lib/types.js';
import { Card, Detail, DetailList } from '../../components/data.js';
import { ErrorPane, InlineAlert, NotYetProduced, SkeletonRows } from '../../components/states.js';
import {
  AiTag,
  AnalysisBadge,
  DuplicateBadge,
  SeverityBadge,
  StatusBadge,
  ValidationBadge,
  statusLabel,
} from '../../components/badges.js';
import {
  formatConfidence,
  formatDateTime,
  formatElapsed,
  formatRelative,
} from '../../lib/format.js';
import { ReportThumb } from '../../components/ReportThumb.js';

export function ReportDetailPage() {
  const { reportId } = useParams<{ reportId: string }>();

  const report = useAsync(
    (signal) => api.get<{ report: ReportDetail }>(`/v1/reports/${reportId}`, { signal }),
    [reportId],
  );
  const analysis = useAsync(
    // A 404/501 here is expected and handled: the analysis endpoint exists but may return
    // nothing meaningful while no AI provider is configured.
    (signal) =>
      api
        .get<ReportAnalysisResponse>(`/v1/reports/${reportId}/analysis`, { signal })
        .catch(() => null),
    [reportId],
  );
  const blocks = useAsync((signal) => api.get<Paginated<Block>>('/v1/campus/blocks', { signal }), []);
  const categories = useAsync(
    (signal) => api.get<Paginated<Category>>('/v1/campus/categories', { signal }),
    [],
  );
  const transactions = useAsync(
    (signal) => api.get<Paginated<TokenTransaction>>('/v1/tokens/transactions?limit=100', { signal }),
    [],
  );

  const data = report.data?.report;

  // The master issue, only when this report is linked to one. A student may read an issue
  // only if they filed one of its reports, which is exactly this case.
  const issue = useAsync<IssueDetailResponse>(
    (signal) =>
      data?.issueId
        ? api.get<IssueDetailResponse>(`/v1/issues/${data.issueId}`, { signal })
        : // A report with no issue id has no ticket to show, so the empty shape must satisfy
          // the same contract the API returns — otherwise TypeScript widens it to `{}`.
          Promise.resolve<IssueDetailResponse>({
            issue: null,
            history: [],
            linkedReports: [],
            linkedReportCount: 0,
          }),
    [data?.issueId],
  );

  const spots = useAsync(
    (signal) =>
      data?.blockId
        ? api.get<Paginated<Spot>>(`/v1/campus/blocks/${data.blockId}/spots`, { signal })
        : Promise.resolve({ items: [], total: 0, limit: 0, offset: 0 }),
    [data?.blockId],
  );

  if (report.loading && !report.data) return <SkeletonRows rows={4} />;
  if (report.error) {
    // 403 is a real possibility here: a student poking at another student's report id.
    return <ErrorPane error={report.error} />;
  }
  if (!data) return <ErrorPane error={report.error!} />;

  const blockName = blocks.data?.items.find((b) => b.id === data.blockId)?.officialName ?? '—';
  const spotName = spots.data?.items.find((s) => s.id === data.spotId)?.officialName ?? '—';
  const floor = spots.data?.items.find((s) => s.id === data.spotId)?.floorLabel ?? null;
  const selectedCategory = categories.data?.items.find((c) => c.id === data.selectedCategoryId);
  const predictedCategory = categories.data?.items.find((c) => c.id === data.aiPredictedCategoryId);

  // Ledger entries for THIS report, read from the same endpoint the tokens page uses. The
  // report row carries a denormalized count; the ledger is the authority, and this shows the
  // actual transactions so a reversal is visible rather than inferred.
  const reportTxns = (transactions.data?.items ?? []).filter((t) => t.reportId === reportId);
  const credits = reportTxns.filter((t) => t.transactionType === 'CREDIT');
  const reversals = reportTxns.filter((t) => t.transactionType === 'REVERSAL');

  const issueHistory = issue.data?.history ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small muted">
            <Link to="/student/reports">← My reports</Link>
          </p>
          <h2 className="page-head__title">{selectedCategory?.name ?? 'Report'}</h2>
          <p className="page-head__subtitle">
            {blockName}
            {floor ? ` · ${floor}` : ''} · submitted {formatRelative(data.submittedAt)}
          </p>
        </div>
        <StatusBadge status={issue.data?.issue?.status ?? null} />
      </div>

      <div className="grid-2">
        <div className="stack stack--5">
          <Card title="Photograph">
            <ReportThumb
              reportId={data.id}
              hasEvidence={data.hasEvidence}
              size={320}
              className="detail-photo"
            />
            <p className="small muted mt-3 mb-0">
              Private — visible only to you and to the campus staff handling this report.
            </p>
          </Card>

          <Card title="Location">
            <DetailList>
              <Detail label="Block">{blockName}</Detail>
              <Detail label="Spot">{spotName}</Detail>
              <Detail label="Floor">{floor ?? '—'}</Detail>
              <Detail label="GPS">
                {data.latitude !== null && data.longitude !== null ? (
                  `${data.latitude}, ${data.longitude}`
                ) : (
                  <span className="muted">Not captured (optional)</span>
                )}
              </Detail>
              <Detail label="Captured">{formatDateTime(data.capturedAt)}</Detail>
              <Detail label="Submitted">{formatDateTime(data.submittedAt)}</Detail>
            </DetailList>
          </Card>

          {issue.data?.issue && (
            <Card
              title="Repair ticket"
              action={<StatusBadge status={issue.data.issue.status} />}
            >
              <DetailList>
                <Detail label="Reference">
                  <span className="mono strong">{issue.data.issue.publicReference}</span>
                </Detail>
                <Detail label="Reports on this ticket">{issue.data.issue.reportCount}</Detail>
                <Detail label="Age">{formatElapsed(issue.data.issue.createdAt)}</Detail>
                {issue.data.issue.claimedByDisplayName && (
                  <Detail label="Assigned to">{issue.data.issue.claimedByDisplayName}</Detail>
                )}
                {issue.data.issue.overdue && (
                  <Detail label="Overdue">
                    <span className="badge badge--danger">Past its due date</span>
                  </Detail>
                )}
                {issue.data.issue.resolutionNote && (
                  <Detail label="Resolution note">{issue.data.issue.resolutionNote}</Detail>
                )}
                {issue.data.issue.resolvedAt && (
                  <Detail label="Resolved">{formatDateTime(issue.data.issue.resolvedAt)}</Detail>
                )}
              </DetailList>

              {issue.data.issue.reportCount > 1 && (
                <div className="mt-4">
                  <InlineAlert variant="info" title="Other students reported this too">
                    {issue.data.issue.reportCount} reports are attached to this one repair ticket. Your
                    report is still yours, with its own photograph and its own token credit — they were
                    merged so the department fixes the problem once instead of three times.
                  </InlineAlert>
                </div>
              )}
            </Card>
          )}

          {issueHistory.length > 0 && (
            <Card title="Progress" subtitle="Recorded by campus staff.">
              <ol className="timeline">
                {issueHistory.map((entry: IssueHistoryEntry) => (
                  <li key={entry.id} className="timeline__item">
                    <span className="timeline__marker timeline__marker--done" aria-hidden="true">
                      ✓
                    </span>
                    <div className="timeline__body">
                      <p className="timeline__title">
                        {entry.previousStatus ? `${statusLabel(entry.previousStatus)} → ` : ''}
                        {statusLabel(entry.newStatus)}
                      </p>
                      <p className="timeline__meta">
                        {formatDateTime(entry.createdAt)}
                        {entry.changedByDisplayName ? ` · ${entry.changedByDisplayName}` : ''}
                      </p>
                      {entry.reason && <p className="small mt-0">{entry.reason}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </div>

        <div className="stack stack--5">
          <Card title="Validation">
            <DetailList>
              <Detail label="Report status">
                <ValidationBadge status={data.validationStatus} />
              </Detail>
              <Detail label="Duplicate check">
                <DuplicateBadge status={data.duplicateMatchStatus} />
              </Detail>
              {analysis.data?.analysis && (
                <Detail label="Analysis">
                  <AnalysisBadge status={analysis.data.analysis.status} />
                </Detail>
              )}
            </DetailList>
          </Card>

          <Card
            title={
              <>
                AI assessment <AiTag />
              </>
            }
            subtitle="What the model concluded about your photograph."
          >
            <DetailList>
              <Detail label="You chose">{selectedCategory?.name ?? '—'}</Detail>
              <Detail label="AI predicted">
                {predictedCategory ? (
                  <>
                    {predictedCategory.name}
                    {data.aiPredictedCategoryId !== data.selectedCategoryId && (
                      <span className="small muted" style={{ display: 'block' }}>
                        Disagrees with your choice — a person will review it.
                      </span>
                    )}
                  </>
                ) : (
                  <NotYetProduced what="A category prediction" />
                )}
              </Detail>
              <Detail label="Confidence">
                {data.aiConfidence !== null ? (
                  <>
                    {formatConfidence(data.aiConfidence)}
                    <span className="small muted" style={{ display: 'block' }}>
                      A ranking score, not a calibrated probability.
                    </span>
                  </>
                ) : (
                  <NotYetProduced what="A confidence score" />
                )}
              </Detail>
              <Detail label="Severity">
                {data.aiSeverity ? (
                  <SeverityBadge severity={data.aiSeverity} source="AI" />
                ) : (
                  <NotYetProduced what="A severity recommendation" />
                )}
              </Detail>
              <Detail label="Repair advice">
                {data.repairRecommendation ?? <NotYetProduced what="Repair recommendations" />}
              </Detail>
            </DetailList>

            {!analysis.data?.analysis?.provider || analysis.data.analysis.provider === 'unconfigured' ? (
              <div className="mt-4">
                <InlineAlert variant="info" title="No AI provider is configured on this server">
                  Your report was recorded and routed normally. The AI assessment columns are empty
                  because <code className="mono">AI_PROVIDER</code> is set to{' '}
                  <code className="mono">unconfigured</code> on this deployment — nothing is being
                  guessed or filled in.
                </InlineAlert>
              </div>
            ) : null}
          </Card>

          <Card title="Tokens for this report">
            {reportTxns.length === 0 ? (
              <p className="muted mb-0">
                No ledger entry for this report yet. Tokens are credited only after the report passes
                validation.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Type</th>
                      <th scope="col" className="table__num">
                        Amount
                      </th>
                      <th scope="col">Recorded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportTxns.map((transaction) => (
                      <tr key={transaction.id}>
                        <td>
                          {transaction.transactionType === 'CREDIT' ? (
                            <span className="badge badge--resolved">Credit</span>
                          ) : (
                            <span className="badge badge--danger">Reversal</span>
                          )}
                          {transaction.reason && (
                            <div className="small muted">{transaction.reason}</div>
                          )}
                        </td>
                        <td className="table__num">
                          <span
                            className={
                              transaction.transactionType === 'CREDIT' ? 'amount--credit' : 'amount--debit'
                            }
                          >
                            {transaction.transactionType === 'CREDIT' ? '+' : '−'}
                            {transaction.amount}
                          </span>
                        </td>
                        <td className="small">{formatDateTime(transaction.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {credits.length > 0 && reversals.length > 0 && (
              <p className="small muted mt-3 mb-0">
                A credit and a reversal both exist for this report — the net effect is{' '}
                {credits.reduce((sum, t) => sum + t.amount, 0) - reversals.reduce((sum, t) => sum + t.amount, 0)}.
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
