/**
 * @campus/contracts — THE shared API contract for AI Sustainable Campus.
 *
 * Boundary rule: both the student/HOD app and the admin website import from here.
 * Neither client may define its own status transitions, token rules, or role logic.
 * Every schema below is enforced server-side; the client copy is for typing + UX only.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* 1. Primitive enums & identifiers                                    */
/* ------------------------------------------------------------------ */

export const RoleSchema = z.enum(['STUDENT', 'HOD', 'ADMIN']);
export type Role = z.infer<typeof RoleSchema>;

/** Lifecycle from the brief, Section 3 Step D. Extended only by explicit revision. */
export const IssueStatusSchema = z.enum(['SUBMITTED', 'APPROVED', 'IN_PROGRESS', 'RESOLVED']);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

export const SeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type Severity = z.infer<typeof SeveritySchema>;

export const AccountStatusSchema = z.enum(['ACTIVE', 'SUSPENDED']);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const WorkspaceKindSchema = z.enum(['REAL', 'DEMO']);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

export const ReportValidationStatusSchema = z.enum([
  'PENDING',               // stored, awaiting AI/human validation — NOT yet token-eligible
  'AI_VALIDATED',          // confirmed by AI pipeline
  'HUMAN_VALIDATED',       // confirmed by staff
  'DUPLICATE_VALIDATED',   // valid duplicate merged into an existing master issue
  'REJECTED',              // not a genuine issue (failed validation)
]);
export type ReportValidationStatus = z.infer<typeof ReportValidationStatusSchema>;

export const DuplicateMatchStatusSchema = z.enum([
  'NOT_CHECKED',
  'NO_MATCH',
  'CANDIDATE_FOUND',   // AI suggests a possible duplicate — REQUIRES human confirmation
  'LINKED',            // confirmed duplicate; master issue owns the repair
  'HUMAN_OVERRIDDEN',  // staff decided a suggested duplicate is actually distinct
]);
export type DuplicateMatchStatus = z.infer<typeof DuplicateMatchStatusSchema>;

export const TokenTransactionTypeSchema = z.enum(['CREDIT', 'REVERSAL']);
export type TokenTransactionType = z.infer<typeof TokenTransactionTypeSchema>;

export const AiAnalysisStatusSchema = z.enum([
  'PENDING', 'SUCCEEDED', 'FAILED', 'NEEDS_HUMAN_REVIEW',
]);
export type AiAnalysisStatus = z.infer<typeof AiAnalysisStatusSchema>;

/* ------------------------------------------------------------------ */
/* 2. Token policy — server-owned constants. Clients must NOT re-derive. */
/* ------------------------------------------------------------------ */

export const TOKEN_POLICY = {
  /** Brief Step C: 10 tokens per AI-validated submission, duplicates included. */
  TOKENS_PER_VALIDATED_REPORT: 10,
  /** Only these validation outcomes are token-eligible. */
  ELIGIBLE_VALIDATION_STATUSES: [
    'AI_VALIDATED',
    'HUMAN_VALIDATED',
    'DUPLICATE_VALIDATED',
  ] as const satisfies readonly ReportValidationStatus[],
  /** Brief Step D: overdue threshold, configurable via OVERDUE_HOURS (not hardcoded). */
  DEFAULT_OVERDUE_HOURS: 72,
} as const;

/** Canonical idempotency key for a report's credit award (brief: retries must not double-award). */
export const tokenCreditIdempotencyKey = (reportId: string): string => `report:${reportId}:validated-credit`;

/* ------------------------------------------------------------------ */
/* 3. Error envelope — one convention across every endpoint            */
/* ------------------------------------------------------------------ */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'INVALID_SESSION',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_STATE_TRANSITION',
  'ALREADY_CLAIMED',
  'RESOLUTION_NOTE_REQUIRED',
  'DUPLICATE_REQUEST',
  'WORKSPACE_VIOLATION',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    /** Populated for VALIDATION_FAILED so the client can highlight fields. */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    /** Correlates the client-visible error with the server log line. */
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/* ------------------------------------------------------------------ */
/* 4. Auth                                                             */
/* ------------------------------------------------------------------ */

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Must be a valid university email address' }));

export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const SessionUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string(),
  role: RoleSchema,
  accountStatus: AccountStatusSchema,
  workspace: WorkspaceKindSchema,
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const LoginResponseSchema = z.object({
  /** Opaque bearer token. Store only in memory / secure storage. Never in localStorage on shared machines. */
  accessToken: z.string(),
  expiresAt: z.iso.datetime(),
  user: SessionUserSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/**
 * NOTE: registration deliberately has NO `role` field.
 * Brief rule: "No role assignment based solely on user-controlled registration input."
 * A `role` sent by a client is ignored server-side (verified by test).
 */
export const RegisterRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  displayName: z.string().trim().min(2).max(120),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

/* ------------------------------------------------------------------ */
/* 5. Campus                                                           */
/* ------------------------------------------------------------------ */

export const CampusBlockSchema = z.object({
  id: z.uuid(),
  officialName: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
});
export type CampusBlock = z.infer<typeof CampusBlockSchema>;

export const CampusSpotSchema = z.object({
  id: z.uuid(),
  blockId: z.uuid(),
  officialName: z.string(),
  buildingLabel: z.string().nullable(),
  floorLabel: z.string().nullable(),
  /** Advisory only — never required for a valid report (brief Section 7C). */
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  active: z.boolean(),
});
export type CampusSpot = z.infer<typeof CampusSpotSchema>;

export const IssueCategorySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
});
export type IssueCategory = z.infer<typeof IssueCategorySchema>;

/* ------------------------------------------------------------------ */
/* 6. Reports                                                          */
/* ------------------------------------------------------------------ */

export const CreateReportRequestSchema = z.object({
  /** Client-selected, authoritative for WHERE the student says it is (unless staff correct it). */
  blockId: z.uuid(),
  spotId: z.uuid(),
  selectedCategoryId: z.uuid(),
  title: z.string().trim().min(5).max(160),
  description: z.string().trim().max(2000).optional(),
  /** UNTRUSTED. Stored as evidence only; the server records submittedAt itself. */
  capturedAt: z.iso.datetime().optional(),
  latitude: z.number().gte(-90).lte(90).optional(),
  longitude: z.number().gte(-180).lte(180).optional(),
  /** Free-form reporting context (device, accuracy, etc.). */
  reportingContext: z.record(z.string(), z.unknown()).optional(),
});
export type CreateReportRequest = z.infer<typeof CreateReportRequestSchema>;

export const ReportSchema = z.object({
  id: z.uuid(),
  issueId: z.uuid().nullable(),
  reporterUserId: z.uuid(),
  selectedCategoryId: z.uuid(),
  aiPredictedCategoryId: z.uuid().nullable(),
  aiConfidence: z.number().nullable(),
  aiSeverity: SeveritySchema.nullable(),
  repairRecommendation: z.string().nullable(),
  validationStatus: ReportValidationStatusSchema,
  duplicateMatchStatus: DuplicateMatchStatusSchema,
  blockId: z.uuid(),
  spotId: z.uuid(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  /** Client-claimed capture time — untrusted evidence. */
  capturedAt: z.iso.datetime().nullable(),
  /** Server-recorded, authoritative. */
  submittedAt: z.iso.datetime(),
  /** True only when the evidence photo has actually been uploaded and stored. */
  hasEvidence: z.boolean(),
  /** Relative URL the client may GET; authorization is enforced by the server. */
  evidenceUrl: z.string().nullable(),
  /** True when this report earned tokens (server-decided, never client-decided). */
  tokenEligible: z.boolean(),
  tokensAwarded: z.number().int(),
});
export type Report = z.infer<typeof ReportSchema>;

/* ------------------------------------------------------------------ */
/* 7. Issues (master repair tickets)                                   */
/* ------------------------------------------------------------------ */

export const IssueSchema = z.object({
  id: z.uuid(),
  publicReference: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  categoryId: z.uuid(),
  severity: SeveritySchema.nullable(),
  status: IssueStatusSchema,
  blockId: z.uuid(),
  spotId: z.uuid(),
  claimedByUserId: z.uuid().nullable(),
  claimedByDisplayName: z.string().nullable(),
  createdByUserId: z.uuid(),
  approvedAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  resolutionNote: z.string().nullable(),
  dueAt: z.iso.datetime(),
  /** Derived from the configurable overdue threshold, never hardcoded in clients. */
  overdue: z.boolean(),
  /** Optimistic-concurrency guard for the double-claim race. */
  version: z.number().int(),
  reportCount: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Issue = z.infer<typeof IssueSchema>;

/**
 * Issue queue filters.
 *
 * Phase 3 §12 asks for severity and date-range filtering. Both are supported by the query
 * rather than approximated in the browser: filtering a page of results client-side would
 * report a `total` that does not match what is on screen, which is worse than not offering
 * the filter at all (recorded as gap G4 in docs/PHASE3_AUDIT.md before it was closed here).
 */
export const ListIssuesQuerySchema = z.object({
  status: IssueStatusSchema.optional(),
  blockId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  claimedByUserId: z.uuid().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  /**
   * Operational severity. `UNSET` selects issues with no severity recorded — a sentinel, so
   * that "not yet triaged" is reachable in the UI. Omitted means no severity filter at all,
   * which is why the sentinel is needed rather than relying on an empty value.
   */
  severity: z.union([SeveritySchema, z.literal('UNSET')]).optional(),
  /** Matches issues with at least one report carrying this AI severity. A filter, not a value. */
  anyReportAiSeverity: SeveritySchema.optional(),
  /** ISO instants. Inclusive lower bound, exclusive upper bound. */
  createdAfter: z.string().datetime({ offset: true }).optional(),
  createdBefore: z.string().datetime({ offset: true }).optional(),
  /** Bounded pagination — brief Section 8 forbids unbounded queries. */
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Human confirmation of an issue's operational severity (Phase 3 gap G2).
 *
 * `null` is accepted and clears the value. It is NOT the same as omitting the field: an
 * explicit null means "we looked and decided there is no severity", which an operator may
 * legitimately need to record after a re-triage.
 *
 * This writes `issues.severity` — the operational column. It never touches
 * `reports.ai_severity`, so the model's opinion survives the human's decision.
 */
export const SetIssueSeverityRequestSchema = z.object({
  severity: SeveritySchema.nullable(),
  reason: z.string().trim().max(1000).optional(),
});

/** Correction of a mis-filed category (Phase 3 gap G3). The student's own choice is not rewritten. */
export const SetIssueCategoryRequestSchema = z.object({
  categoryId: z.uuid(),
  reason: z.string().trim().max(1000).optional(),
});
export type ListIssuesQuery = z.infer<typeof ListIssuesQuerySchema>;

export const PaginatedIssuesSchema = z.object({
  items: z.array(IssueSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type PaginatedIssues = z.infer<typeof PaginatedIssuesSchema>;

export const ClaimIssueRequestSchema = z.object({
  expectedVersion: z.number().int().nonnegative().optional(),
});

export const ResolveIssueRequestSchema = z.object({
  /** Brief: "Resolution requires a non-empty completion note." */
  resolutionNote: z.string().trim().min(10, 'A completion note is required (min 10 characters)').max(4000),
});

export const TransitionReasonSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});

/* ------------------------------------------------------------------ */
/* 8. Tokens                                                           */
/* ------------------------------------------------------------------ */

export const RedeemRequestSchema = z.object({
  rewardId: z.uuid(),
  idempotencyKey: z.string().min(8).max(200),
});

export const TokenBalanceSchema = z.object({
  userId: z.uuid(),
  /** Always derived from the immutable ledger, never a mutable counter alone. */
  balance: z.number().int(),
  lifetimeCredited: z.number().int(),
  lifetimeReversed: z.number().int(),
});
export type TokenBalance = z.infer<typeof TokenBalanceSchema>;

export const TokenTransactionSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  reportId: z.uuid().nullable(),
  transactionType: TokenTransactionTypeSchema,
  amount: z.number().int().positive(),
  idempotencyKey: z.string(),
  reason: z.string().nullable(),
  createdByUserId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type TokenTransaction = z.infer<typeof TokenTransactionSchema>;

export const ReverseTokensRequestSchema = z.object({
  /** Brief: reversals require a recorded reason. */
  reason: z.string().trim().min(5, 'A reason is required for a reversal').max(1000),
  transactionId: z.uuid().optional(),
  reportId: z.uuid().optional(),
  amount: z.number().int().positive().optional(),
});

/* ------------------------------------------------------------------ */
/* 9. AI adapter contract (interface only — engine arrives in Phase 2) */
/* ------------------------------------------------------------------ */

export const AiDuplicateCandidateSchema = z.object({
  issueId: z.uuid(),
  score: z.number().min(0).max(1),
  reason: z.string(),
});

export const AiAnalysisResultSchema = z.object({
  reportId: z.uuid(),
  provider: z.string(),
  model: z.string(),
  modelVersion: z.string(),
  status: AiAnalysisStatusSchema,
  predictedCategoryId: z.uuid().nullable(),
  categoryMatchesStudentSelection: z.boolean().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  severity: SeveritySchema.nullable(),
  repairRecommendation: z.string().nullable(),
  duplicateCandidates: z.array(AiDuplicateCandidateSchema),
  /** Any analysis below this confidence must NOT drive an irreversible decision. */
  requiresHumanReview: z.boolean(),
});
export type AiAnalysisResult = z.infer<typeof AiAnalysisResultSchema>;

export const AI_REVIEW_CONFIDENCE_THRESHOLD = 0.7;

/* ------------------------------------------------------------------ */
/* 10. Event contract (outbox → future WebSocket/SSE transport)        */
/* ------------------------------------------------------------------ */

export const EVENT_TYPES = [
  'report.created',
  'report.validated',
  'issue.created',
  'issue.duplicate_linked',
  'issue.status_changed',
  'issue.claimed',
  'issue.resolved',
  'token.credited',
  'token.reversed',
  /* Phase 2 — AI pipeline events (brief §17). Declared here so the outbox, the future
     transport and every client agree on one vocabulary. */
  'report.analysis_started',
  'report.analysis_completed',
  'report.analysis_failed',
  'report.review_required',
  'report.duplicate_candidate_found',
  'report.linked_to_master_issue',
  'report.duplicate_rejected',
  /* Phase 3 — human corrections to the operational record. Separate verbs because neither is
     a status transition: an event consumer replaying the log must not see a status change
     that never happened. Migration 0008 adds the matching CHECK-constraint entries. */
  'issue.severity_changed',
  'issue.category_changed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EventEnvelopeSchema = z.object({
  eventId: z.uuid(),
  eventType: z.enum(EVENT_TYPES),
  occurredAt: z.iso.datetime(),
  /** Workspace scope — subscribers may only receive their own. */
  workspace: WorkspaceKindSchema,
  entityType: z.enum(['REPORT', 'ISSUE', 'TOKEN_TRANSACTION']),
  entityId: z.uuid(),
  /** Monotonic per-entity version for ordering / gap detection. */
  entityVersion: z.number().int(),
  actorUserId: z.uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/* ------------------------------------------------------------------ */
/* 11. Health                                                          */
/* ------------------------------------------------------------------ */

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.object({ ok: z.boolean(), latencyMs: z.number().nullable(), error: z.string().nullable() }),
  version: z.string(),
  uptimeSeconds: z.number(),
});
