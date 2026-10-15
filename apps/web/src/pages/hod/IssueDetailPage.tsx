/**
 * A single issue, from the operational side (§10).
 *
 * THIS IS WHERE THE WORKFLOW ACTUALLY HAPPENS. Every action on this page calls a real
 * endpoint that exists today, and every panel reads a value the server returned:
 *
 *   Claim         POST /v1/issues/:id/claim
 *   Approve       POST /v1/issues/:id/approve
 *   Start work    POST /v1/issues/:id/start
 *   Resolve       POST /v1/issues/:id/resolve            (completion note required)
 *   Severity      PATCH /v1/issues/:id/severity          (human-confirmed, not the AI's)
 *   Category      PATCH /v1/issues/:id/category
 *   Validate a report + award tokens
 *                 POST /v1/reports/:id/validation
 *   Reverse tokens POST /v1/tokens/reverse               (reason required, audited)
 *
 * WHAT IS DELIBERATELY ABSENT. There is no "merge as duplicate" control, because the merge
 * decision endpoints do not exist yet (audit gap G5) and they depend on Phase 2 Stage 5
 * duplicate detection. Candidate matches are shown as candidates. A button that posted
 * nothing, or that changed a local status, would be a fake workflow.
 *
 * ON `expectedVersion`. The claim request carries the version the page loaded with, so a
 * second HOD who has the same issue open gets a version conflict instead of silently
 * stealing the claim. That is the client half of the guard the domain layer enforces; the
 * server half is the row lock, and it is the half that actually protects the data.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api.js';
import { useAsync } from '../../lib/useAsync.js';
import type {
  IssueDetailResponse,
  LinkedReport,
  Paginated,
  ReportAnalysisResponse,
  TokenTransaction,
} from '../../lib/types.js';
import { Card, Detail, DetailList } from '../../components/data.js';
import { ErrorPane, InlineAlert, NotYetProduced, SkeletonRows } from '../../components/states.js';
import {
  AiTag,
  AnalysisBadge,
  DuplicateBadge,
  OverdueBadge,
  SeverityBadge,
  StatusBadge,
  ValidationBadge,
  statusLabel,
} from '../../components/badges.js';
import { ConfirmDialog, Modal } from '../../components/dialog.js';
import { useToast } from '../../components/toast.js';
import { formatConfidence, formatDateTime, formatElapsed } from '../../lib/format.js';
import { useCampusLookup } from '../../lib/campus.js';
import { useSession } from '../../lib/session.js';
import { ReportThumb } from '../../components/ReportThumb.js';

const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export function IssueDetailPage() {
  const { issueId } = useParams<{ issueId: string }>();
  const campus = useCampusLookup();
  const { user } = useSession();
  const toast = useToast();

  const detail = useAsync(
    (signal) => api.get<IssueDetailResponse>(`/v1/issues/${issueId}`, { signal }),
    [issueId],
  );

  // Which report is open in the validation modal, if any.
  const [validatingReport, setValidatingReport] = useState<LinkedReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | Error | null>(null);
  const [resolving, setResolving] = useState(false);
  const [confirmingClaim, setConfirmingClaim] = useState(false);

  const issue = detail.data?.issue ?? null;
  const isStaff = user?.role === 'HOD' || user?.role === 'ADMIN';

  // The lifecycle timeline comes from the real history rows, so a transition taken outside
  // this UI still appears here.
  const history = detail.data?.history ?? [];
  const linkedReports = detail.data?.linkedReports ?? [];

  const transactions = useAsync(
    (signal) => api.get<Paginated<TokenTransaction>>('/v1/tokens/transactions?limit=100', { signal }),
    [],
  );

  /** Runs a mutation, surfaces its real result, and refreshes from the server. */
  async function act(label: string, run: () => Promise<unknown>, successMessage: string) {
    setBusy(label);
    setActionError(null);
    try {
      await run();
      toast.success(successMessage);
      detail.reload();
      transactions.reload();
    } catch (caught) {
      // The server's own message is shown. A version conflict and a permission failure are
      // different problems and the user needs to be able to tell them apart.
      const error = caught instanceof Error ? caught : new Error('The action failed.');
      setActionError(error);
      toast.error('That action did not complete.', error.message);
    } finally {
      setBusy(null);
    }
  }

  if (detail.loading && !detail.data) return <SkeletonRows rows={6} />;
  if (detail.error) return <ErrorPane error={detail.error} onRetry={detail.reload} />;
  if (!issue) {
    return (
      <Card>
        <p className="muted mb-0">
          This issue could not be loaded. It may belong to another workspace, or your session may not
          have access to it.
        </p>
      </Card>
    );
  }

  const base = user?.role === 'ADMIN' ? '/admin/issues' : '/hod/issues';
  const claimable = isStaff && issue.status !== 'RESOLVED' && !issue.claimedByUserId;
  const claimedByMe = issue.claimedByUserId === user?.id;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small muted">
            <Link to={base}>← Issue queue</Link>
          </p>
          <h2 className="page-head__title">{issue.title}</h2>
          <p className="page-head__subtitle">
            <span className="mono">{issue.publicReference}</span> · {campus.blockName(issue.blockId)} ·{' '}
            {campus.categoryName(issue.categoryId)} · raised {formatElapsed(issue.createdAt)} ago
          </p>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          {issue.overdue && <OverdueBadge />}
          <StatusBadge status={issue.status} />
        </div>
      </div>

      {actionError && (
        <div className="mb-5">
          <InlineAlert
            variant="error"
            title={actionError instanceof ApiError && actionError.isForbidden
              ? 'The server refused that action'
              : 'That action did not complete'}
            details={actionError instanceof ApiError ? actionError.details : undefined}
          >
            {actionError.message}
            {actionError instanceof ApiError && actionError.status === 0 && (
              <span> The server could not be reached, so nothing was changed.</span>
            )}
          </InlineAlert>
        </div>
      )}

      {issue.status === 'RESOLVED' && issue.resolutionNote && (
        <div className="mb-5">
          <InlineAlert variant="success" title="Resolved">
            {issue.resolutionNote}
            {issue.resolvedAt && (
              <span className="small" style={{ display: 'block', marginTop: 4 }}>
                Closed {formatDateTime(issue.resolvedAt)}
              </span>
            )}
          </InlineAlert>
        </div>
      )}

      <div className="grid-2">
        {/* ------------------------- left: the work ------------------------- */}
        <div className="stack stack--5">
          <Card
            title="Reports on this ticket"
            subtitle={
              linkedReports.length === linkedReports.length && (detail.data?.linkedReportCount ?? 0) > 1
                ? `${detail.data!.linkedReportCount} reports — merged so the defect is fixed once.`
                : 'Each report keeps its own photograph, category and token credit.'
            }
            flush
          >
            {linkedReports.length === 0 ? (
              <p className="muted" style={{ padding: 'var(--space-4)' }}>
                No reports are attached to this ticket.
              </p>
            ) : (
              <div>
                {linkedReports.map((report, index) => (
                  <ReportRow
                    key={report.id}
                    report={report}
                    isFirst={index === 0}
                    campus={campus}
                    onValidate={() => setValidatingReport(report)}
                    canValidate={isStaff && report.validationStatus === 'PENDING'}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card title="Progress" subtitle="Every recorded transition, oldest first.">
            {history.length === 0 ? (
              <p className="muted mb-0">No transitions recorded yet.</p>
            ) : (
              <ol className="timeline">
                {history.map((entry) => (
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
            )}
          </Card>

          {transactions.data && (
            <Card title="Token ledger entries" subtitle="Every credit and reversal recorded in this campus.">
              {(() => {
                const reportIds = new Set(linkedReports.map((r) => r.id));
                const relevant = transactions.data.items.filter(
                  (t) => t.reportId && reportIds.has(t.reportId),
                );
                if (relevant.length === 0) {
                  return (
                    <p className="muted mb-0">
                      No tokens have been credited for the reports on this ticket yet.
                    </p>
                  );
                }
                return (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Type</th>
                          <th scope="col">Amount</th>
                          <th scope="col">Reason</th>
                          <th scope="col">Recorded</th>
                        </tr>
                      </thead>
                      <tbody>
                        {relevant.map((transaction) => (
                          <tr key={transaction.id}>
                            <td>
                              {transaction.transactionType === 'CREDIT' ? (
                                <span className="badge badge--resolved">Credit</span>
                              ) : (
                                <span className="badge badge--danger">Reversal</span>
                              )}
                            </td>
                            <td>
                              <span
                                className={
                                  transaction.transactionType === 'CREDIT'
                                    ? 'amount--credit'
                                    : 'amount--debit'
                                }
                              >
                                {transaction.transactionType === 'CREDIT' ? '+' : '−'}
                                {transaction.amount}
                              </span>
                            </td>
                            <td className="small">{transaction.reason ?? 'Report validated'}</td>
                            <td className="small nowrap">{formatDateTime(transaction.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </Card>
          )}
        </div>

        {/* ------------------------ right: operations ------------------------ */}
        <div className="stack stack--5">
          <Card title="Actions">
            {!isStaff ? (
              <p className="muted mb-0">
                Only HOD and admin accounts can action an issue. Every request from this page would be
                refused by the server for a student session.
              </p>
            ) : (
              <div className="stack stack--4">
                {claimable && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy !== null}
                    onClick={() => setConfirmingClaim(true)}
                  >
                    {busy === 'claim' ? 'Claiming…' : 'Claim this issue'}
                  </button>
                )}

                {issue.claimedByUserId && (
                  <p className="small muted mb-0">
                    {claimedByMe
                      ? 'You have claimed this issue.'
                      : `Claimed by ${issue.claimedByDisplayName ?? 'another user'}.`}
                  </p>
                )}

                {issue.status === 'SUBMITTED' && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        'approve',
                        () =>
                          api.post(`/v1/issues/${issue.id}/approve`, {
                            reason: 'Approved from the operations console.',
                          }),
                        `${issue.publicReference} approved.`,
                      )
                    }
                  >
                    {busy === 'approve' ? 'Approving…' : 'Approve'}
                  </button>
                )}

                {issue.status === 'APPROVED' && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        'start',
                        () =>
                          api.post(`/v1/issues/${issue.id}/start`, {
                            reason: 'Work started.',
                          }),
                        `${issue.publicReference} marked in progress.`,
                      )
                    }
                  >
                    {busy === 'start' ? 'Starting…' : 'Start work'}
                  </button>
                )}

                {issue.status !== 'RESOLVED' && (
                  <button
                    type="button"
                    className="btn btn--secondary"
                    disabled={busy !== null}
                    onClick={() => setResolving(true)}
                  >
                    Resolve with a completion note…
                  </button>
                )}

                <SeverityEditor
                  issueId={issue.id}
                  current={issue.severity}
                  busy={busy !== null}
                  onSave={(severity, reason) =>
                    act(
                      'severity',
                      () =>
                        api.patch(`/v1/issues/${issue.id}/severity`, {
                          severity,
                          ...(reason ? { reason } : {}),
                        }),
                      severity
                        ? `Severity recorded as ${severity.toLowerCase()}.`
                        : 'Severity cleared.',
                    )
                  }
                />

                <CategoryCorrection
                  issueId={issue.id}
                  currentCategoryId={issue.categoryId}
                  categories={campus.categories}
                  busy={busy !== null}
                  onSave={(categoryId, reason) =>
                    act(
                      'category',
                      () =>
                        api.patch(`/v1/issues/${issue.id}/category`, {
                          categoryId,
                          ...(reason ? { reason } : {}),
                        }),
                      'Category corrected.',
                    )
                  }
                />
              </div>
            )}
          </Card>

          <Card title="Operational detail">
            <DetailList>
              <Detail label="Severity">
                {issue.severity ? (
                  <SeverityBadge severity={issue.severity} source="HUMAN" />
                ) : (
                  <span className="muted">Not set</span>
                )}
              </Detail>
              <Detail label="Due">
                {formatDateTime(issue.dueAt)}
                {issue.overdue && <span className="small muted" style={{ display: 'block' }}>
                  Past its due date
                </span>}
              </Detail>
              <Detail label="Reports">{issue.reportCount}</Detail>
              <Detail label="Version">
                <span className="mono">{issue.version}</span>
                <span className="small muted" style={{ display: 'block' }}>
                  Changes on every write — used to detect two people editing at once.
                </span>
              </Detail>
              <Detail label="Approved">{formatDateTime(issue.approvedAt)}</Detail>
              <Detail label="Started">{formatDateTime(issue.startedAt)}</Detail>
              <Detail label="Resolved">{formatDateTime(issue.resolvedAt)}</Detail>
            </DetailList>
          </Card>
        </div>
      </div>

      {validatingReport && (
        <ValidationModal
          report={validatingReport}
          onClose={() => setValidatingReport(null)}
          onDone={(message) => {
            setValidatingReport(null);
            toast.success(message);
            detail.reload();
            transactions.reload();
          }}
        />
      )}

      {resolving && (
        <ResolveModal
          issueId={issue.id}
          publicReference={issue.publicReference}
          onClose={() => setResolving(false)}
          onDone={(message) => {
            setResolving(false);
            toast.success(message);
            detail.reload();
          }}
        />
      )}

      {confirmingClaim && (
        <ConfirmDialog
          title="Claim this issue?"
          confirmLabel="Claim it"
          onCancel={() => setConfirmingClaim(false)}
          onConfirm={() => {
            setConfirmingClaim(false);
            void act(
              'claim',
              () =>
                api.post(`/v1/issues/${issue.id}/claim`, {
                  // The version this page loaded — the server rejects the claim if the issue moved.
                  expectedVersion: issue.version,
                }),
              `${issue.publicReference} claimed.`,
            );
          }}
        >
          <p className="mb-0">
            {issue.publicReference} will be assigned to you. Another person who already has it open
            will be told it was claimed rather than silently overwriting you, because the claim
            carries the version this page loaded.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

/** One report on the ticket, with its own AI panel and a way to validate it. */
function ReportRow({
  report,
  isFirst,
  campus,
  onValidate,
  canValidate,
}: {
  report: LinkedReport;
  isFirst: boolean;
  campus: ReturnType<typeof useCampusLookup>;
  onValidate: () => void;
  canValidate: boolean;
}) {
  const analysis = useAsync(
    (signal) =>
      api
        .get<ReportAnalysisResponse>(`/v1/reports/${report.id}/analysis`, { signal })
        .catch(() => null),
    [report.id],
  );

  const a = analysis.data?.analysis ?? null;

  return (
    <div className="report-row report-row--stacked">
      <ReportThumb reportId={report.id} hasEvidence={report.hasEvidence} size={88} />
      <div className="report-row__main">
        <p className="report-row__title">
          {isFirst ? 'Original report' : 'Linked report'} ·{' '}
          {campus.categoryName(report.selectedCategoryId)}
        </p>
        <p className="report-row__meta">
          <span>{report.reporterDisplayName ?? 'Reporter hidden'}</span>
          <span>·</span>
          <span>{formatDateTime(report.submittedAt)}</span>
        </p>

        <div className="row row--wrap" style={{ gap: 'var(--space-2)', marginTop: 6 }}>
          <ValidationBadge status={report.validationStatus} />
          <DuplicateBadge status={report.duplicateMatchStatus} />
          {analysis.data?.analysis && <AnalysisBadge status={a!.status} />}
          {report.aiSeverity && <SeverityBadge severity={report.aiSeverity} source="AI" />}
          {report.aiPredictedCategoryId && report.aiPredictedCategoryId !== report.selectedCategoryId && (
            <span className="badge badge--warning">
              AI said {campus.categoryName(report.aiPredictedCategoryId)}
            </span>
          )}
        </div>

        <p className="small muted mt-2 mb-0">
          <AiTag /> Model verdict:{' '}
          {a === null ? (
            <NotYetProduced what="An AI assessment (no analysis has been recorded for this report)" />
          ) : (
            <>
              {campus.categoryName(a.predictedCategoryId)}
              {a.confidence !== null && ` at ${formatConfidence(a.confidence)}`}
              {' — a ranking score, not a calibrated probability.'}
            </>
          )}
        </p>
      </div>

      <div className="report-row__side">
        {canValidate && (
          <button type="button" className="btn btn--primary btn--sm" onClick={onValidate}>
            Validate…
          </button>
        )}
        <a
          className="btn btn--ghost btn--sm"
          href={`/v1/reports/${report.id}/evidence`}
          target="_blank"
          rel="noreferrer"
        >
          Full photo
        </a>
      </div>
    </div>
  );
}

/**
 * The validation decision.
 *
 * This is the seam that awards tokens. §9 is emphatic that tokens must never be calculated or
 * awarded in frontend code — so this form posts a VERDICT and then displays the number the
 * server returns. It never adds 10 to anything, and if the server says nothing was awarded
 * (because a credit already exists for this report) the panel says that instead.
 */
function ValidationModal({
  report,
  onClose,
  onDone,
}: {
  report: LinkedReport;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [verdict, setVerdict] = useState<'HUMAN_VALIDATED' | 'DUPLICATE_VALIDATED' | 'REJECTED'>(
    'HUMAN_VALIDATED',
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [outcome, setOutcome] = useState<{
    tokensAwarded: number;
    alreadyAwarded: boolean;
    idempotencyKey: string | null;
  } | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{
        tokensAwarded: number;
        alreadyAwarded: boolean;
        idempotencyKey: string | null;
      }>(`/v1/reports/${report.id}/validation`, {
        validationStatus: verdict,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setOutcome(result);
      if (result.tokensAwarded > 0) {
        onDone(`${result.tokensAwarded} tokens credited to the reporter.`);
      } else if (result.alreadyAwarded) {
        onDone('Verdict recorded. This report had already been credited.');
      } else {
        onDone('Verdict recorded. No tokens were awarded for this outcome.');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('The verdict could not be recorded.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Record a verdict on this report"
      onClose={onClose}
      footer={
        outcome ? (
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
              {busy ? 'Recording…' : 'Record verdict'}
            </button>
          </>
        )
      }
    >
      {outcome ? (
        <div className="stack stack--4">
          <InlineAlert
            variant={outcome.tokensAwarded > 0 ? 'success' : 'info'}
            title={
              outcome.tokensAwarded > 0
                ? `${outcome.tokensAwarded} tokens credited`
                : outcome.alreadyAwarded
                  ? 'Already credited'
                  : 'No tokens awarded'
            }
          >
            {outcome.tokensAwarded > 0 ? (
              <>
                The ledger now holds a credit of {outcome.tokensAwarded} for this report. This is the
                number the server returned — the page does not compute it.
              </>
            ) : outcome.alreadyAwarded ? (
              <>
                This report already had a credit, so nothing was added. That is the idempotency guard
                doing its job: a repeated verdict cannot pay twice.
              </>
            ) : (
              <>
                The outcome you recorded does not qualify for a credit, so the ledger is unchanged.
              </>
            )}
          </InlineAlert>
          {outcome.idempotencyKey && (
            <p className="small muted mb-0">
              Idempotency key <code className="mono">{outcome.idempotencyKey}</code> — a retry of this
              exact verdict can never create a second credit.
            </p>
          )}
        </div>
      ) : (
        <div className="stack stack--4">
          <InlineAlert variant="info" title="What each verdict does">
            <strong>Validated</strong> accepts the report as a genuine defect and credits the reporter
            with the configured award. <strong>Valid duplicate</strong> also credits them — reporting
            something already known still took effort. <strong>Rejected</strong> records that the
            report is not actionable and awards nothing.
          </InlineAlert>

          <fieldset className="field">
            <legend className="field__label">Verdict</legend>
            <div className="stack stack--3">
              {(
                [
                  ['HUMAN_VALIDATED', 'Validated', 'A real defect. Credits the reporter.'],
                  ['DUPLICATE_VALIDATED', 'Valid duplicate', 'Real, but already reported. Still credits.'],
                  ['REJECTED', 'Rejected', 'Not actionable. No credit.'],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className="radio">
                  <input
                    type="radio"
                    name="verdict"
                    value={value}
                    checked={verdict === value}
                    onChange={() => setVerdict(value)}
                  />
                  <span>
                    <span className="strong">{label}</span>
                    <span className="small muted" style={{ display: 'block' }}>
                      {hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="field">
            <label className="field__label" htmlFor="verdict-reason">
              Reason <span className="muted small">(recorded with the decision)</span>
            </label>
            <textarea
              id="verdict-reason"
              className="textarea"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="For example: inspected on site, pipe replaced by facilities on 16 Oct."
            />
          </div>

          {error && (
            <InlineAlert variant="error" title="The verdict was not recorded">
              {error.message}
            </InlineAlert>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Resolution requires a note of at least ten characters — enforced by the server too. */
function ResolveModal({
  issueId,
  publicReference,
  onClose,
  onDone,
}: {
  issueId: string;
  publicReference: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const tooShort = note.trim().length < 10;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/issues/${issueId}/resolve`, { resolutionNote: note.trim() });
      onDone(`${publicReference} resolved.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('The issue could not be resolved.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Resolve ${publicReference}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void submit()}
            disabled={busy || tooShort}
          >
            {busy ? 'Resolving…' : 'Mark resolved'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field__label" htmlFor="resolution-note">
          What was actually done?
        </label>
        <textarea
          id="resolution-note"
          className="textarea"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="For example: replaced the corroded valve and re-painted the ceiling panel."
        />
        <p className="field__hint">
          {note.trim().length}/10 characters minimum. The server rejects a resolution without it —
          this requirement is enforced on the server, not by this button.
        </p>
      </div>
      {error && (
        <InlineAlert variant="error" title="Could not resolve">
          {error.message}
        </InlineAlert>
      )}
    </Modal>
  );
}

function SeverityEditor({
  current,
  busy,
  onSave,
}: {
  issueId: string;
  current: string | null;
  busy: boolean;
  onSave: (severity: string | null, reason: string) => void;
}) {
  const [value, setValue] = useState<string>(current ?? '');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);

  const changed = value !== (current ?? '');

  return (
    <div className="editor">
      <button type="button" className="editor__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>Severity</span>
        <span className="small muted">{current ? current.toLowerCase() : 'not set'}</span>
      </button>
      {open && (
        <div className="editor__body">
          <p className="small muted mt-0">
            This is the <strong>operational</strong> severity your department works to. It is stored
            separately from the AI's suggestion and never overwrites it.
          </p>
          <div className="row row--wrap" style={{ gap: 'var(--space-2)' }}>
            {SEVERITIES.map((severity) => (
              <button
                key={severity}
                type="button"
                className={`btn btn--sm ${value === severity ? 'btn--primary' : 'btn--secondary'}`}
                onClick={() => setValue(severity)}
                aria-pressed={value === severity}
              >
                {severity.toLowerCase()}
              </button>
            ))}
            <button
              type="button"
              className={`btn btn--sm ${value === '' ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setValue('')}
              aria-pressed={value === ''}
            >
              clear
            </button>
          </div>
          <div className="field mt-3">
            <label className="field__label" htmlFor="sev-reason">
              Reason <span className="muted small">(optional, recorded in the audit log)</span>
            </label>
            <input
              id="sev-reason"
              className="input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={!changed || busy}
            onClick={() => onSave(value === '' ? null : value, reason.trim())}
          >
            {busy ? 'Saving…' : 'Save severity'}
          </button>
          {!changed && <span className="small muted" style={{ marginLeft: 10 }}>No change to save.</span>}
        </div>
      )}
    </div>
  );
}

function CategoryCorrection({
  currentCategoryId,
  categories,
  busy,
  onSave,
}: {
  issueId: string;
  currentCategoryId: string;
  categories: { id: string; name: string }[];
  busy: boolean;
  onSave: (categoryId: string, reason: string) => void;
}) {
  const [value, setValue] = useState(currentCategoryId);
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);

  return (
    <div className="editor">
      <button type="button" className="editor__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>Correct the category</span>
        <span className="small muted">mis-filed?</span>
      </button>
      {open && (
        <div className="editor__body">
          <p className="small muted mt-0">
            This changes the ticket's category only. The category the student originally chose stays on
            their report as a matter of record.
          </p>
          <div className="field">
            <label className="field__label" htmlFor="fix-category">
              Correct category
            </label>
            <select
              id="fix-category"
              className="select"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            >
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="fix-reason">
              Reason <span className="muted small">(optional)</span>
            </label>
            <input
              id="fix-reason"
              className="input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={value === currentCategoryId || busy}
            onClick={() => onSave(value, reason.trim())}
          >
            {busy ? 'Saving…' : 'Save category'}
          </button>
        </div>
      )}
    </div>
  );
}
