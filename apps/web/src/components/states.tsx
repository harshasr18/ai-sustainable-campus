/**
 * Loading, empty, error and permission states.
 *
 * §3 and §5 of the brief ask for "thoughtful loading, empty, success and error states" and
 * §17 requires them on every data page. They live together here so that a page cannot
 * accidentally ship with only the happy path — importing `ErrorPane` is the path of least
 * resistance, which is the only reliable way to get consistent error handling.
 *
 * The error pane is deliberately specific. "Something went wrong" is a dead end for both a
 * user and a developer; distinguishing "not implemented", "not permitted" and "server
 * problem" tells the reader what to do next, and a request id makes the failure traceable
 * in the server log.
 */

import type { ReactNode } from 'react';
import { ApiError } from '../lib/api.js';

export function LoadingPane({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Skeleton rows for list/table loading, which reads better than a spinner on white. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack stack--4" style={{ padding: 'var(--space-5)' }} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="row" style={{ gap: 'var(--space-4)' }}>
          <div className="skeleton" style={{ width: 52, height: 52, borderRadius: 8 }} />
          <div className="stack stack--2" style={{ flex: 1 }}>
            <div className="skeleton" style={{ width: `${60 - index * 6}%` }} />
            <div className="skeleton" style={{ width: '35%', height: 10 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyPane({
  title,
  text,
  action,
  icon = '○',
}: {
  title: string;
  text?: string;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="state">
      <div className="state__icon" aria-hidden="true">
        {icon}
      </div>
      <p className="state__title">{title}</p>
      {text && <p className="state__text">{text}</p>}
      {action && <div className="state__actions">{action}</div>}
    </div>
  );
}

export function ErrorPane({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  // 501 is not a failure — it is the backend honestly reporting that a feature is not
  // implemented. Presenting that as an error would be misleading, so it gets its own
  // wording and no "Retry", because retrying will not change the answer.
  if (error.isNotImplemented) {
    return (
      <InlineAlert variant="info" title="Not implemented yet">
        {error.message}
      </InlineAlert>
    );
  }

  if (error.isForbidden) {
    return (
      <EmptyPane
        icon="🔒"
        title="You do not have access to this"
        text="Your account does not have permission to view this page. If you believe that is wrong, contact an administrator."
      />
    );
  }

  return (
    <div className="state">
      <div className="state__icon" aria-hidden="true" style={{ color: 'var(--danger)' }}>
        !
      </div>
      <p className="state__title">Could not load this</p>
      <p className="state__text">{error.message}</p>
      {error.requestId && (
        <p className="state__text mono" style={{ fontSize: 'var(--text-xs)' }}>
          Request {error.requestId}
        </p>
      )}
      {onRetry && (
        <div className="state__actions">
          <button type="button" className="btn btn--secondary" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function InlineAlert({
  variant = 'info',
  title,
  children,
  details,
  action,
}: {
  variant?: 'error' | 'warning' | 'info' | 'success' | 'ai';
  title?: string;
  children?: ReactNode;
  details?: { path: string; message: string }[];
  action?: ReactNode;
}) {
  const glyph = { error: '!', warning: '⚠', info: 'i', success: '✓', ai: '✦' }[variant];
  return (
    <div className={`alert alert--${variant}`} role={variant === 'error' ? 'alert' : undefined}>
      <span aria-hidden="true" className="strong">
        {glyph}
      </span>
      <div className="alert__body">
        {title && <p className="alert__title">{title}</p>}
        {children}
        {details && details.length > 0 && (
          <ul className="alert__details">
            {details.map((detail, index) => (
              <li key={index}>
                {detail.path}: {detail.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      {action}
    </div>
  );
}

/**
 * Renders a value the AI was supposed to produce but has not yet.
 *
 * This exists because Phase 2 Stages 5–6 are not built: severity, repair recommendations
 * and duplicate candidates are currently always empty. Showing "—" would imply the model
 * looked and found nothing; this states plainly that the output does not exist yet, which
 * is the honest answer per §3 ("Fake AI outputs" is forbidden, and so is implying one).
 */
export function NotYetProduced({ what }: { what: string }) {
  return (
    <span className="muted small" title={`${what} is produced by a later Phase 2 stage and does not exist yet.`}>
      Not produced yet
    </span>
  );
}
