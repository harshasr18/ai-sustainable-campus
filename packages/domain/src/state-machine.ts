/**
 * Issue lifecycle state machine — PURE and fully unit-testable.
 *
 *   SUBMITTED ──► APPROVED ──► IN_PROGRESS ──► RESOLVED
 *
 * This module is the SINGLE source of truth for allowed transitions and for who
 * may perform them. It is imported by the API server. It is NOT re-implemented in
 * the mobile app or the admin website — those read `status` and render buttons
 * from `allowedTransitions()`, which the server also uses. One rule, one place.
 *
 * Deliberately NOT supported in Phase 1 (per the brief: "extend the state machine
 * explicitly and update the tests" if added later):
 *   - REJECTED reports
 *   - REOPENED issues
 *   - a distinct maintenance-assignment workflow
 * Adding any of these means extending TRANSITIONS and updating the tests; there is
 * no generic "set status" escape hatch anywhere in the codebase.
 */
import type { IssueStatus, Role } from '@campus/contracts';
import { forbidden, invalidTransition } from './errors.js';

export interface TransitionRule {
  from: IssueStatus;
  to: IssueStatus;
  /** Roles permitted to perform this transition. */
  roles: readonly Role[];
  /** Human-readable description, reused by clients for button labels. */
  label: string;
  /** When true the request must carry a non-empty resolution note. */
  requiresResolutionNote?: boolean;
}

export const TRANSITIONS: readonly TransitionRule[] = Object.freeze([
  { from: 'SUBMITTED',   to: 'APPROVED',    roles: ['HOD', 'ADMIN'], label: 'Approve' },
  { from: 'APPROVED',    to: 'IN_PROGRESS', roles: ['HOD', 'ADMIN'], label: 'Start work' },
  {
    from: 'IN_PROGRESS',
    to: 'RESOLVED',
    roles: ['HOD', 'ADMIN'],
    label: 'Mark resolved',
    requiresResolutionNote: true,
  },
]);

/** RESOLVED is terminal in Phase 1. */
export const TERMINAL_STATUSES: readonly IssueStatus[] = Object.freeze(['RESOLVED', 'DUPLICATE']);

export const ALL_STATUSES: readonly IssueStatus[] = Object.freeze([
  'SUBMITTED',
  'APPROVED',
  'IN_PROGRESS',
  'RESOLVED',
  'DUPLICATE',
]);

export function findTransition(from: IssueStatus, to: IssueStatus): TransitionRule | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/** Transitions this actor may perform *on role alone*, ignoring note requirements. */
export function allowedTransitions(from: IssueStatus, role: Role): TransitionRule[] {
  return TRANSITIONS.filter((t) => t.from === from && t.roles.includes(role));
}

/**
 * Validates a requested transition for an actor. Throws DomainError with a clear,
 * client-safe message; returns the rule on success.
 *
 * Ordering matters: authorization is checked BEFORE state validity so an
 * unauthorized actor cannot use error messages to probe workflow state.
 */
export function assertTransition(params: {
  from: IssueStatus;
  to: IssueStatus;
  role: Role;
  resolutionNote?: string | null;
}): TransitionRule {
  const { from, to, role } = params;

  const rule = findTransition(from, to);
  if (!rule) {
    throw invalidTransition(
      `Cannot move an issue from ${from} to ${to}. Allowed next state(s) from ${from}: ` +
        `${TRANSITIONS.filter((t) => t.from === from).map((t) => t.to).join(', ') || 'none (terminal state)'}.`,
    );
  }

  if (!rule.roles.includes(role)) {
    throw forbidden(`Role ${role} is not permitted to perform "${rule.label}" (${from} → ${to}).`);
  }

  if (rule.requiresResolutionNote) {
    const note = params.resolutionNote?.trim() ?? '';
    if (note.length === 0) {
      throw invalidTransition('A completion note is required when resolving an issue.');
    }
  }

  return rule;
}

/** Guards for the claim endpoint, which is a separate operation from transition. */
export function assertCanClaim(role: Role): void {
  if (!(role === 'HOD' || role === 'ADMIN')) {
    throw forbidden('Only HOD or ADMIN users can claim issues.');
  }
}

/** Students may read their own reports; HOD/ADMIN may read the operational queue. */
export function assertCanViewIssueQueue(role: Role): void {
  if (!(role === 'HOD' || role === 'ADMIN')) {
    throw forbidden('Only HOD or ADMIN users can browse the full issue queue.');
  }
}

/**
 * Guard for operational edits that are neither a status transition nor a claim — confirming
 * severity, correcting a category. Same authority as the rest of the operational surface:
 * HOD and ADMIN only, decided HERE rather than in a route handler or the UI.
 */
export function assertCanOperate(role: Role): void {
  if (!(role === 'HOD' || role === 'ADMIN')) {
    throw forbidden('Only HOD or ADMIN users can change the operational record of an issue.');
  }
}
