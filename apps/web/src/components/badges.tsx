/**
 * Shared status vocabulary.
 *
 * Every badge maps a REAL backend value to a label — nothing is invented here, and an
 * unknown value degrades to a neutral badge showing the raw value rather than silently
 * rendering nothing. That matters: if the backend gains a status before the UI knows about
 * it, an operator should see the truth, not a blank cell.
 *
 * The AI badge deliberately has its own hue. §11 of the brief requires the HOD to
 * distinguish an AI recommendation from a human decision, and colour is the fastest signal.
 */

import type { ReactNode } from 'react';

/* ------------------------------- Issues ------------------------------- */

const ISSUE_STATUS: Record<string, { label: string; modifier: string; description: string }> = {
  SUBMITTED: {
    label: 'Submitted',
    modifier: 'submitted',
    description: 'Awaiting review by the department.',
  },
  APPROVED: {
    label: 'Approved',
    modifier: 'approved',
    description: 'Approved for work; not yet started.',
  },
  IN_PROGRESS: {
    label: 'In progress',
    modifier: 'progress',
    description: 'Repair work is under way.',
  },
  RESOLVED: {
    label: 'Resolved',
    modifier: 'resolved',
    description: 'Work completed and a resolution note recorded.',
  },
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="badge badge--neutral">Unknown</span>;
  const meta = ISSUE_STATUS[status];
  if (!meta) return <span className="badge badge--neutral">{status}</span>;
  return (
    <span className={`badge badge--${meta.modifier}`} title={meta.description}>
      {meta.label}
    </span>
  );
}

export function statusLabel(status: string | null | undefined): string {
  if (!status) return 'Unknown';
  return ISSUE_STATUS[status]?.label ?? status;
}

/* ------------------------------- Severity ------------------------------- */

const SEVERITY: Record<string, string> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

/**
 * Severity badge. `unset` is rendered as an explicit "Not set" rather than an empty space,
 * because an unset severity is actionable information for an HOD — it means nobody has
 * assessed the issue yet.
 */
export function SeverityBadge({
  severity,
  source,
}: {
  severity: string | null | undefined;
  /** 'AI' marks a model recommendation; omitted means a human value. */
  source?: 'AI' | 'HUMAN';
}) {
  if (!severity) {
    return (
      <span className="badge badge--neutral" title="No severity has been assessed yet">
        Not set
      </span>
    );
  }
  const modifier = SEVERITY[severity] ?? 'low';
  return (
    <span className={`badge badge--${modifier}`}>
      {severity.charAt(0) + severity.slice(1).toLowerCase()}
      {source === 'AI' && <span className="sr-only"> (AI recommendation)</span>}
    </span>
  );
}

/* ------------------------------- AI markers ------------------------------- */

/**
 * Marks a value as produced by the model rather than by a person. Used anywhere an AI
 * output appears, so the two can never be confused at a glance.
 */
export function AiTag({ children = 'AI' }: { children?: ReactNode }) {
  return (
    <span className="badge badge--ai" title="Produced by the AI model, not by a person">
      {children}
    </span>
  );
}

/* ------------------------------- Workspace ------------------------------- */

export function WorkspaceTag({ workspace }: { workspace: 'REAL' | 'DEMO' }) {
  return workspace === 'DEMO' ? (
    <span className="badge badge--demo" title="Demo workspace — sample data, isolated from the real campus">
      Demo data
    </span>
  ) : (
    <span className="badge badge--real" title="Real campus records">
      Real campus
    </span>
  );
}

/* ------------------------------- Overdue ------------------------------- */

export function OverdueBadge({ elapsed }: { elapsed?: string }) {
  return (
    <span className="badge badge--danger" title="Past its due date">
      ⚠ Overdue{elapsed ? ` · ${elapsed}` : ''}
    </span>
  );
}

/* --------------------------- Report validation --------------------------- */
/**
 * The report-level validation vocabulary, which is SEPARATE from the issue workflow status.
 * §8 requires rendering the status the backend actually returns rather than forcing
 * everything into the four-stage issue sequence.
 */
const REPORT_VALIDATION: Record<string, { label: string; modifier: string }> = {
  PENDING: { label: 'Awaiting validation', modifier: 'submitted' },
  AI_VALIDATED: { label: 'AI validated', modifier: 'resolved' },
  HUMAN_VALIDATED: { label: 'Human validated', modifier: 'approved' },
  DUPLICATE_VALIDATED: { label: 'Valid duplicate', modifier: 'progress' },
  REJECTED: { label: 'Rejected', modifier: 'danger' },
};

export function ValidationBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="badge badge--neutral">—</span>;
  const meta = REPORT_VALIDATION[status];
  if (!meta) return <span className="badge badge--neutral">{status}</span>;
  return <span className={`badge badge--${meta.modifier}`}>{meta.label}</span>;
}

/* ------------------------- Duplicate match state ------------------------- */

const DUPLICATE_STATE: Record<string, { label: string; modifier: string; title: string }> = {
  NOT_CHECKED: {
    label: 'Not checked',
    modifier: 'neutral',
    title: 'Duplicate detection has not run for this report yet.',
  },
  NO_MATCH: {
    label: 'No duplicate found',
    modifier: 'neutral',
    title: 'No other report matches this defect.',
  },
  CANDIDATE_FOUND: {
    label: 'Possible duplicate',
    modifier: 'submitted',
    title: 'A possible duplicate was found and needs a human decision before anything is merged.',
  },
  LINKED: {
    label: 'Linked to a master issue',
    modifier: 'progress',
    title: 'This report is one of several covering the same defect.',
  },
  HUMAN_OVERRIDDEN: {
    label: 'Reviewed by a person',
    modifier: 'approved',
    title: 'A person reviewed and decided this duplicate suggestion.',
  },
};

export function DuplicateBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="badge badge--neutral">Not checked</span>;
  const meta = DUPLICATE_STATE[status];
  if (!meta) return <span className="badge badge--neutral">{status}</span>;
  return (
    <span className={`badge badge--${meta.modifier}`} title={meta.title}>
      {meta.label}
    </span>
  );
}

/* --------------------------- Analysis status --------------------------- */

const ANALYSIS_STATE: Record<string, { label: string; modifier: string }> = {
  PENDING: { label: 'Analysis pending', modifier: 'submitted' },
  SUCCEEDED: { label: 'Analysis complete', modifier: 'resolved' },
  NEEDS_HUMAN_REVIEW: { label: 'Needs review', modifier: 'submitted' },
  FAILED: { label: 'Analysis failed', modifier: 'danger' },
};

export function AnalysisBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const meta = ANALYSIS_STATE[status];
  if (!meta) return <span className="badge badge--neutral">{status}</span>;
  return <span className={`badge badge--${meta.modifier}`}>{meta.label}</span>;
}
