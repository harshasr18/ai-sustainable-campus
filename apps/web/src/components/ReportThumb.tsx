/**
 * Authorized photograph thumbnail.
 *
 * Cannot be `<img src="/v1/reports/:id/evidence">` — that request would go out without the
 * session's Authorization header and be correctly refused. See lib/evidence.ts for the full
 * explanation. This component is the only place the pattern is implemented, so every
 * thumbnail in the app behaves identically.
 *
 * THE FOUR STATES ARE DIFFERENT ON PURPOSE:
 *   loading   — a quiet placeholder, no spinner, because twenty spinners is noise;
 *   forbidden — a distinct lock, because "this is not yours" is not an error;
 *   missing   — a dashed frame, because no photo is a normal state for old records;
 *   error     — a warning glyph with the message in a title, so it is diagnosable.
 * Collapsing these into one broken-image icon is what makes a UI feel untrustworthy.
 */

import { useEvidence } from '../lib/evidence.js';

export function ReportThumb({
  reportId,
  hasEvidence,
  size = 52,
  className = 'report-row__thumb',
}: {
  reportId: string | null | undefined;
  hasEvidence: boolean;
  size?: number;
  className?: string;
}) {
  const evidence = useEvidence(hasEvidence ? reportId : null);

  if (!hasEvidence) {
    return (
      <div className={className} style={{ width: size, height: size }} title="No photograph on this record">
        <span aria-hidden="true">—</span>
        <span className="sr-only">No photograph</span>
      </div>
    );
  }

  if (evidence.status === 'ready') {
    return (
      <div className={className} style={{ width: size, height: size }}>
        <img src={evidence.url} alt="Photograph submitted with this report" loading="lazy" />
      </div>
    );
  }

  if (evidence.status === 'forbidden') {
    return (
      <div className={className} style={{ width: size, height: size }} title="You are not authorized to view this photograph">
        <span aria-hidden="true">🔒</span>
        <span className="sr-only">Photograph not available to you</span>
      </div>
    );
  }

  if (evidence.status === 'missing') {
    return (
      <div className={className} style={{ width: size, height: size }} title="The stored photograph is missing">
        <span aria-hidden="true">?</span>
        <span className="sr-only">Photograph missing</span>
      </div>
    );
  }

  if (evidence.status === 'error') {
    return (
      <div className={className} style={{ width: size, height: size }} title={evidence.message}>
        <span aria-hidden="true">⚠</span>
        <span className="sr-only">Photograph could not be loaded</span>
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{ width: size, height: size }}
      aria-busy="true"
      title="Loading photograph"
    >
      <span className="sr-only">Loading photograph…</span>
    </div>
  );
}
