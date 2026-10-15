/**
 * Small data-display primitives shared across dashboards.
 *
 * Deliberately few. Four tiles, a card, a pagination control and a definition list cover
 * every screen in this app; a larger component library would be more code to maintain than
 * to write.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function Card({
  title,
  action,
  children,
  flush = false,
  subtitle,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="card">
      {(title || action) && (
        <header className="card__head">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {subtitle && <p className="small muted mt-0">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={flush ? 'card__body--flush' : 'card__body'}>{children}</div>
    </section>
  );
}

/**
 * A single metric.
 *
 * `value` is always supplied by the caller from a real API response — there is no default
 * and no sample number, which is what stops a "56" appearing on a dashboard that has never
 * seen a database (§6: "Do not hardcode sample numbers").
 *
 * `value: null` renders as an em dash with an explanatory note, which is visibly different
 * from zero. "No data yet" and "counted zero" are different facts.
 */
export function StatTile({
  label,
  value,
  foot,
  tone = 'default',
  href,
  title,
}: {
  label: string;
  value: number | string | null;
  foot?: ReactNode;
  tone?: 'default' | 'accent' | 'warning' | 'danger' | 'success';
  href?: string;
  title?: string;
}) {
  const className = ['stat', tone !== 'default' ? `stat--${tone}` : ''].filter(Boolean).join(' ');

  const body = (
    <>
      <span className="stat__label">{label}</span>
      <span className={`stat__value${value === null ? ' stat__value--muted' : ''}`}>
        {value === null ? '—' : value}
      </span>
      {foot && <span className="stat__foot">{foot}</span>}
    </>
  );

  if (href) {
    // An INTERNAL link is a router link, not an <a href>: a plain anchor would reload the
    // whole application and lose the session-hydrated state on every tile click. An external
    // URL still gets an anchor, and gets the safety attributes it needs.
    if (href.startsWith('/')) {
      return (
        <Link className={className} to={href} title={title}>
          {body}
        </Link>
      );
    }
    return (
      <a className={className} href={href} title={title} rel="noreferrer noopener" target="_blank">
        {body}
      </a>
    );
  }

  return (
    <div className={className} title={title}>
      {body}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}

/**
 * Server-side pagination control.
 *
 * The API is bounded (`limit` max 100) and returns `total`, so the client never needs to
 * hold the whole dataset — §10 asks for exactly that ("without loading the entire dataset
 * into the browser").
 */
export function Pagination({
  total,
  limit,
  offset,
  onChange,
  busy = false,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
  busy?: boolean;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const canPrev = offset > 0;
  const canNext = offset + limit < total;

  return (
    <div className="pagination">
      <span>
        {total === 0 ? 'No results' : `${from}–${to} of ${total}`}
      </span>
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={!canPrev || busy}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={!canNext || busy}
          onClick={() => onChange(offset + limit)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

/** Label/value pairs — used for every detail panel. */
export function DetailList({ children }: { children: ReactNode }) {
  return <dl className="dl">{children}</dl>;
}

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
