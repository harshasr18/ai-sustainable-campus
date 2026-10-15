/**
 * Review queue (§10 / §11) — reports the AI would not accept on its own.
 *
 * WHAT PUTS A REPORT HERE. An analysis row with `requires_human_review = true`, which is set
 * when the model's confidence was below the configured threshold, when the margin between the
 * top two categories was too small to separate them, or when the prediction disagreed with
 * the student's own choice. The server decides this; the client never re-derives it from a
 * confidence number it has been given. `GET /v1/admin/review-queue` is the authority.
 *
 * THE HONEST EMPTY STATE. When no AI provider is configured — the default in this deployment
 * — this queue is genuinely empty because nothing has been assessed, which is a completely
 * different fact from "everything has been reviewed". The page checks `/v1/admin/ai/status`
 * and says which of the two it is. An empty queue presented as "all clear" would be a
 * fabricated reassurance.
 *
 * WHAT THIS PAGE DELIBERATELY DOES NOT DO. It does not offer a "Merge" or "Confirm duplicate"
 * button, because §11's merge/reject decision endpoints do not exist yet (audit gap G5). A
 * button that silently posted nothing, or that wrote a local status change, would be a fake
 * workflow. Duplicate candidates are shown as candidates — never as confirmed merges — which
 * is also what the domain layer enforces.
 */

import { Link } from 'react-router-dom';
import { api, query } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type { AiStatus, ReviewQueueItem } from '../../lib/types.js';
import { Card } from '../../components/data.js';
import { EmptyPane, ErrorPane, InlineAlert, SkeletonRows } from '../../components/states.js';
import { AiTag, DuplicateBadge } from '../../components/badges.js';
import { formatConfidence, formatDateTime, formatElapsed } from '../../lib/format.js';
import { useCampusLookup } from '../../lib/campus.js';
import { ReportThumb } from '../../components/ReportThumb.js';

/** Matches the endpoint's own maximum; the count is then known to be exact below this. */
const LIMIT = 200;

export function ReviewQueuePage() {
  const campus = useCampusLookup();

  const queue = useAsync(
    (signal) =>
      api.get<{ count: number; items: ReviewQueueItem[] }>(
        `/v1/admin/review-queue${query({ limit: LIMIT })}`,
        { signal },
      ),
    [],
  );
  const aiStatus = useAsync((signal) => api.get<AiStatus>('/v1/admin/ai/status', { signal }), []);

  const items = queue.data?.items ?? [];
  const truncated = (queue.data?.count ?? 0) >= LIMIT;
  const aiConfigured = aiStatus.data?.configured ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">
            Review queue <AiTag />
          </h2>
          <p className="page-head__subtitle">
            Reports the model was not confident enough to accept. A person decides each one.
          </p>
        </div>
        <Link to="/hod/issues" className="btn btn--secondary">
          Issue queue
        </Link>
      </div>

      {aiStatus.data && !aiStatus.data.configured && (
        <div className="mb-5">
          <InlineAlert variant="info" title="No AI provider is configured on this server">
            Nothing has been assessed, so nothing is waiting here — this is not a clean bill of
            health. Provider is <code className="mono">{aiStatus.data.provider}</code>, model{' '}
            <code className="mono">{aiStatus.data.model}</code>. Set{' '}
            <code className="mono">AI_PROVIDER</code> to run analysis; see{' '}
            <span className="mono">docs/AI_MODEL.md</span>.
          </InlineAlert>
        </div>
      )}

      {queue.error ? (
        <ErrorPane error={queue.error} onRetry={queue.reload} />
      ) : queue.loading && !queue.data ? (
        <SkeletonRows rows={5} />
      ) : items.length === 0 ? (
        <Card>
          <EmptyPane
            icon={aiConfigured ? '✓' : '○'}
            title={
              aiConfigured === false
                ? 'Nothing has been analysed yet'
                : aiConfigured === null
                  ? 'Review queue'
                  : 'Nothing needs a human decision'
            }
            text={
              aiConfigured === false
                ? 'The queue fills once a model is configured and reports are analysed. The provider is unconfigured, so this is expected — not a sign that reports are clean.'
                : 'Every analysis so far was confident enough to stand on its own. New low-confidence or disagreeing results will appear here.'
            }
            action={
              <Link to="/hod/issues" className="btn btn--secondary">
                Go to the issue queue
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <p className="small muted mb-3">
            Showing {items.length}
            {truncated ? `+ (the endpoint returns at most ${LIMIT})` : ''} of{' '}
            {queue.data?.count ?? 0} awaiting review
            {aiStatus.data ? ` · review threshold ${aiStatus.data.humanReviewConfidenceThreshold}` : ''}.
          </p>

          <div className="stack stack--4">
            {items.map((item) => {
              const candidates = Array.isArray(item.duplicateCandidates)
                ? (item.duplicateCandidates as { issueId?: string; score?: number; reason?: string }[])
                : [];

              return (
                <Card key={item.analysisId}>
                  <div className="grid-2">
                    <div>
                      <ReportThumb reportId={item.reportId} hasEvidence size={220} />
                      <p className="small muted mt-2 mb-0">
                        Analysed {formatElapsed(item.createdAt)} ago
                      </p>
                    </div>

                    <div>
                      <div className="row-between mb-3">
                        <div>
                          <p className="strong mb-0">
                            Student chose{' '}
                            <span className="muted">
                              {campus.categoryName(item.selectedCategoryId)}
                            </span>
                          </p>
                          <p className="mb-0">
                            Model predicted{' '}
                            <strong>{campus.categoryName(item.predictedCategoryId)}</strong>
                          </p>
                        </div>
                        {item.categoryMatchesChoice === false && (
                          <span className="badge badge--warning">Disagrees</span>
                        )}
                      </div>

                      <dl className="dl">
                        <dt>Confidence</dt>
                        <dd>
                          {item.confidence === null ? (
                            <span className="muted">Not recorded</span>
                          ) : (
                            <>
                              {formatConfidence(item.confidence)}
                              <span className="small muted" style={{ display: 'block' }}>
                                Ranking score, not a calibrated probability.
                              </span>
                            </>
                          )}
                        </dd>
                        <dt>Analysis status</dt>
                        <dd className="mono small">{item.status}</dd>
                        <dt>Duplicate candidates</dt>
                        <dd>
                          {candidates.length === 0 ? (
                            <span className="muted">None recorded</span>
                          ) : (
                            <span className="badge badge--progress">
                              {candidates.length} candidate{candidates.length === 1 ? '' : 's'}
                            </span>
                          )}
                        </dd>
                      </dl>

                      {candidates.length > 0 && (
                        <InlineAlert variant="warning" title="Candidates, not confirmations">
                          These are candidate matches only. Merging needs `POST
                          /v1/issues/:id/duplicates/:reportId/confirm` (audit gap G5), which is not
                          implemented — so nothing here can be merged from the UI yet.
                        </InlineAlert>
                      )}

                      <div className="btn-row mt-4">
                        <Link
                          to={item.issueId ? `/hod/issues/${item.issueId}` : '/hod/issues'}
                          className="btn btn--secondary btn--sm"
                        >
                          Open the issue
                        </Link>
                        <Link
                          to={`/student/reports/${item.reportId}`}
                          className="btn btn--ghost btn--sm"
                        >
                          Report detail
                        </Link>
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          <div className="mt-5">
            <InlineAlert variant="info" title="What happens to a report after review">
              A human verdict is recorded through{' '}
              <code className="mono">POST /v1/reports/:id/validation</code>, which is also the only
              place tokens are awarded — 10 per validated report, including a valid duplicate. The
              confirmation panel for that decision lands with Phase 2 Stage 5–6, alongside duplicate
              detection and severity, so that nothing about this screen is simulated in the meantime.
            </InlineAlert>
          </div>
        </>
      )}
    </>
  );
}
