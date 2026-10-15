/**
 * Domain errors.
 *
 * Every failure that should reach a client as a specific status code is expressed
 * as a DomainError with a code from the shared contract. Route handlers translate
 * these; they never invent their own error strings. Anything that is NOT a
 * DomainError is treated as an internal fault and is never leaked to clients.
 */
import type { ErrorCode } from '@campus/contracts';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: { path: string; message: string }[];

  constructor(code: ErrorCode, message: string, httpStatus: number, details?: { path: string; message: string }[]) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** 401 — no credentials, or credentials that cannot be resolved to a session. */
export const unauthenticated = (message = 'Authentication required') =>
  new DomainError('UNAUTHENTICATED', message, 401);

export const invalidCredentials = () =>
  // Deliberately identical for "unknown email" and "wrong password" to avoid
  // confirming which university emails exist.
  new DomainError('INVALID_CREDENTIALS', 'Invalid email or password', 401);

export const invalidSession = (message = 'Session is invalid or has expired') =>
  new DomainError('INVALID_SESSION', message, 401);

/** 403 — authenticated but not permitted. */
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new DomainError('FORBIDDEN', message, 403);

export const notFound = (message = 'Resource not found') => new DomainError('NOT_FOUND', message, 404);

/** 409 — the request is valid but the current state forbids it. */
export const invalidTransition = (message: string) =>
  new DomainError('INVALID_STATE_TRANSITION', message, 409);

export const alreadyClaimed = (message = 'This issue has already been claimed by another user') =>
  new DomainError('ALREADY_CLAIMED', message, 409);

export const resolutionNoteRequired = () =>
  new DomainError('RESOLUTION_NOTE_REQUIRED', 'A completion note is required to resolve an issue', 400);

export const conflict = (message: string) => new DomainError('DUPLICATE_REQUEST', message, 409);

/** 400 — malformed or semantically invalid input. */
export const validationFailed = (message: string, details?: { path: string; message: string }[]) =>
  new DomainError('VALIDATION_FAILED', message, 400, details);

/** 403 — a demo session attempted to touch real data, or vice versa. */
export const workspaceViolation = () =>
  new DomainError('WORKSPACE_VIOLATION', 'This operation is not permitted in the current workspace', 403);

/** 501 — a declared interface whose implementation lands in a later phase. */
export const notImplemented = (message = 'Not implemented yet') => new DomainError('NOT_IMPLEMENTED', message, 501);
