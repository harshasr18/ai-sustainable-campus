/**
 * Token reward policy — server-side only.
 *
 * Brief Step C: "Do not award tokens merely because a browser sends a
 * successful-looking request. Token eligibility must be decided by trusted
 * server-side logic."
 *
 * Consequences enforced here:
 *  1. Eligibility is a function of the report's VALIDATION STATUS, which only the
 *     server (AI pipeline or staff review) can set. A client cannot request tokens.
 *  2. A valid duplicate earns its own 10 tokens (brief Step C) while sharing one
 *     master ticket — so eligibility is independent of "created a new issue".
 *  3. Awards are idempotent at the storage layer via UNIQUE(idempotency_key).
 *  4. A REJECTED report never earns tokens, and a retry can never double-award.
 */
import { TOKEN_POLICY, tokenCreditIdempotencyKey, type ReportValidationStatus } from '@campus/contracts';
import type { Conn } from '@campus/db';
import { tokens as tokenRepo } from '@campus/db';
import { forbidden, validationFailed } from './errors.js';

export function isTokenEligible(validationStatus: ReportValidationStatus): boolean {
  return (TOKEN_POLICY.ELIGIBLE_VALIDATION_STATUSES as readonly ReportValidationStatus[]).includes(validationStatus);
}

export interface AwardOutcome {
  awarded: boolean;
  /** False when this exact award was already recorded — a retry, not an error. */
  inserted: boolean;
  amount: number;
  transactionId: string | null;
}

/**
 * Awards tokens for a validated report. Safe to call repeatedly (retries, duplicate
 * deliveries from a queue); the ledger constraint guarantees a single award.
 *
 * MUST be called inside the same transaction that set the validation status, so
 * "report marked validated" and "tokens awarded" cannot diverge.
 */
export async function awardForValidatedReport(
  tx: Conn,
  input: {
    workspaceId: string;
    userId: string;
    reportId: string;
    validationStatus: ReportValidationStatus;
    amount?: number;
    reason?: string;
  },
): Promise<AwardOutcome> {
  if (!isTokenEligible(input.validationStatus)) {
    return { awarded: false, inserted: false, amount: 0, transactionId: null };
  }

  const amount = input.amount ?? TOKEN_POLICY.TOKENS_PER_VALIDATED_REPORT;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw validationFailed('Token amount must be a positive integer.');
  }

  const result = await tokenRepo.record(tx, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    reportId: input.reportId,
    transactionType: 'CREDIT',
    amount,
    // Deterministic key: the SAME report can only ever produce ONE credit.
    idempotencyKey: tokenCreditIdempotencyKey(input.reportId),
    reason: input.reason ?? `Validated report (${input.validationStatus})`,
    createdByUserId: null, // system-generated
  });

  return { awarded: true, inserted: result.inserted, amount, transactionId: result.id };
}

/**
 * Reverses a previous credit. Requires an authorized actor AND a recorded reason —
 * both re-checked here and additionally enforced by a CHECK constraint on the table,
 * so no code path can write an unattributed reversal.
 */
export async function reverseTokens(
  tx: Conn,
  input: {
    workspaceId: string;
    userId: string;
    reportId: string | null;
    amount: number;
    reason: string;
    actorUserId: string;
    actorRole: 'STUDENT' | 'HOD' | 'ADMIN';
    /** Optional explicit key; defaults to a deterministic one per report+reason. */
    idempotencyKey?: string;
  },
): Promise<AwardOutcome> {
  if (input.actorRole !== 'ADMIN' && input.actorRole !== 'HOD') {
    throw forbidden('Only HOD or ADMIN users may reverse token awards.');
  }
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 5) {
    throw validationFailed('A reason of at least 5 characters is required to reverse tokens.');
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw validationFailed('Reversal amount must be a positive integer.');
  }

  const key =
    input.idempotencyKey ??
    (input.reportId ? `report:${input.reportId}:reversal:${reason.slice(0, 40)}` : `manual:${crypto.randomUUID()}`);

  const result = await tokenRepo.record(tx, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    reportId: input.reportId,
    transactionType: 'REVERSAL',
    amount: input.amount,
    idempotencyKey: key,
    reason,
    createdByUserId: input.actorUserId,
  });

  return { awarded: true, inserted: result.inserted, amount: input.amount, transactionId: result.id };
}
