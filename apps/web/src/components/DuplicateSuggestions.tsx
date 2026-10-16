/**
 * Duplicate suggestions — the HOD's decision panel (Phase 5).
 *
 * Each suggestion was produced by an explicit server rule (same block + spot/category
 * signals), never by photo similarity alone, and carries no score because none was
 * measured. This panel shows the facts that fired and offers exactly two decisions:
 *
 *   "Same defect — merge"  POST /v1/duplicate-suggestions/:id/confirm
 *   "Different defect"     POST /v1/duplicate-suggestions/:id/dismiss
 *
 * Nothing is shown as done until the server answers 200; a failure is shown as a failure.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import type { DuplicateSuggestion } from '../lib/types.js';
import { useToast } from './toast.js';
import { StatusBadge } from './badges.js';
import { formatElapsed } from '../lib/format.js';

export function describeSuggestion(s: DuplicateSuggestion): string {
  if (s.reasonCode === 'SAME_SPOT_AI_CATEGORY') {
    const conf = typeof s.signals.modelConfidence === 'number' ? ` (model score ${s.signals.modelConfidence.toFixed(2)}, uncalibrated)` : '';
    return `Same spot. The student chose a different category, but the vision model classified the photo as “${s.candidateCategoryName ?? 'the candidate’s category'}”${conf}, which is already open here.`;
  }
  return `Same block and same category, at a different named spot (${s.candidateSpotName ?? 'another spot'}), opened in the last ${String(s.signals.withinHours ?? 72)} hours. Students sometimes describe one place differently.`;
}

export function DuplicateSuggestionList({
  suggestions,
  onDecided,
  issueLinkBase = '/hod/issues',
  showSource = false,
}: {
  suggestions: DuplicateSuggestion[];
  onDecided: () => void;
  issueLinkBase?: string;
  /** Show which ticket the suggestion is about (for the cross-issue review list). */
  showSource?: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function decide(s: DuplicateSuggestion, decision: 'confirm' | 'dismiss') {
    setBusy(s.id);
    setErrors((e) => ({ ...e, [s.id]: '' }));
    try {
      const note = notes[s.id]?.trim();
      await api.post(`/v1/duplicate-suggestions/${s.id}/${decision}`, note ? { note } : {});
      toast.success(
        decision === 'confirm'
          ? `${s.sourceIssueReference} merged into ${s.candidateIssueReference}.`
          : `Kept ${s.sourceIssueReference} and ${s.candidateIssueReference} as separate issues.`,
      );
      onDecided();
    } catch (caught) {
      setErrors((e) => ({ ...e, [s.id]: caught instanceof ApiError ? caught.message : 'The decision was not saved.' }));
    } finally {
      setBusy(null);
    }
  }

  const open = suggestions.filter((s) => s.status === 'OPEN');
  const decided = suggestions.filter((s) => s.status !== 'OPEN');

  return (
    <div className="stack stack--3" data-testid="duplicate-suggestions">
      {open.map((s) => (
        <div key={s.id} className="dup-suggestion" data-suggestion-id={s.id}>
          <div className="row row--between">
            <p className="small strong mt-0 mb-0">
              {showSource && (
                <>
                  <Link to={`${issueLinkBase}/${s.sourceIssueId}`} className="mono">{s.sourceIssueReference}</Link> may be the same defect as{' '}
                </>
              )}
              {!showSource && 'Possibly the same defect as '}
              <Link to={`${issueLinkBase}/${s.candidateIssueId}`} className="mono">{s.candidateIssueReference}</Link>
            </p>
            <StatusBadge status={s.candidateStatus} />
          </div>
          <p className="small muted mt-2 mb-3">
            {describeSuggestion(s)} The master has {s.candidateReportCount} report{s.candidateReportCount === 1 ? '' : 's'}. Found{' '}
            {formatElapsed(s.createdAt)} ago.
          </p>
          <label className="field__label small" htmlFor={`dup-note-${s.id}`}>
            Note (optional)
          </label>
          <input
            id={`dup-note-${s.id}`}
            className="input"
            maxLength={500}
            value={notes[s.id] ?? ''}
            onChange={(e) => setNotes((n) => ({ ...n, [s.id]: e.target.value }))}
            placeholder="e.g. same light, reported from the other doorway"
          />
          {errors[s.id] && (
            <p className="small mt-2" role="alert" style={{ color: 'var(--danger)' }}>
              {errors[s.id]}
            </p>
          )}
          <div className="btn-row mt-3">
            <button type="button" className="btn btn--primary btn--sm" disabled={busy !== null} onClick={() => void decide(s, 'confirm')}>
              {busy === s.id ? 'Saving…' : 'Same defect — merge'}
            </button>
            <button type="button" className="btn btn--secondary btn--sm" disabled={busy !== null} onClick={() => void decide(s, 'dismiss')}>
              Different defect
            </button>
          </div>
        </div>
      ))}
      {decided.length > 0 && (
        <ul className="small muted mt-0 mb-0" style={{ paddingLeft: '1.1rem' }}>
          {decided.map((s) => (
            <li key={s.id}>
              {s.status === 'CONFIRMED' ? 'Merged' : s.status === 'DISMISSED' ? 'Kept separate from' : 'Superseded —'}{' '}
              <span className="mono">{s.candidateIssueReference}</span>
              {s.decidedAt ? ` · ${formatElapsed(s.decidedAt)} ago` : ''}
              {s.decisionNote ? ` · “${s.decisionNote}”` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
