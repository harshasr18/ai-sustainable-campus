/**
 * API response types for the web client.
 *
 * These mirror the actual response bodies, which I read from the route handlers rather than
 * inferring from names. Where a shape differs from the `@campus/contracts` Zod schema, that
 * is noted — the contracts describe the *domain* object, and several routes return a
 * deliberately narrower view of it (for example `/v1/reports/mine` returns a list projection,
 * not the full report).
 *
 * Types only. No runtime validation here: the server validates, and re-validating every
 * response in the browser would be duplicate work for no added safety.
 */

import type { Severity, IssueStatus } from '@campus/contracts';

export interface Block {
  id: string;
  officialName: string;
  slug: string;
  description: string | null;
  active: boolean;
}

export interface Spot {
  id: string;
  blockId: string;
  officialName: string;
  buildingLabel: string | null;
  floorLabel: string | null;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  active: boolean;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** A row from `GET /v1/reports/mine` — a list projection, not the whole report. */
export interface MyReport {
  id: string;
  issueId: string | null;
  validationStatus: string;
  duplicateMatchStatus: string;
  blockId: string;
  spotId: string;
  selectedCategoryId: string;
  capturedAt: string | null;
  submittedAt: string;
  hasEvidence: boolean;
  evidenceUrl: string | null;
  tokensAwarded: number;
}

/** `GET /v1/reports/:id` */
export interface ReportDetail {
  id: string;
  issueId: string | null;
  reporterUserId: string;
  selectedCategoryId: string;
  aiPredictedCategoryId: string | null;
  aiConfidence: number | null;
  aiSeverity: Severity | null;
  repairRecommendation: string | null;
  validationStatus: string;
  duplicateMatchStatus: string;
  blockId: string;
  spotId: string;
  latitude: number | null;
  longitude: number | null;
  capturedAt: string | null;
  submittedAt: string;
  hasEvidence: boolean;
  evidenceUrl: string | null;
}

/** `GET /v1/issues` row — the enriched projection the list and detail both use. */
export interface Issue {
  id: string;
  publicReference: string;
  title: string;
  description: string | null;
  categoryId: string;
  severity: Severity | null;
  status: IssueStatus;
  blockId: string;
  spotId: string;
  claimedByUserId: string | null;
  claimedByDisplayName: string | null;
  createdByUserId: string;
  approvedAt: string | null;
  startedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  dueAt: string;
  /** Computed server-side from the configurable overdue threshold. Never recomputed here. */
  overdue: boolean;
  version: number;
  reportCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface IssueHistoryEntry {
  id: string;
  previousStatus: string | null;
  newStatus: string;
  reason: string | null;
  changedByDisplayName: string | null;
  createdAt: string;
}

/** `GET /v1/issues/:id` */
export interface IssueDetailResponse {
  issue: Issue | null;
  history: IssueHistoryEntry[];
  linkedReportCount: number;
}

/** `GET /v1/tokens/balance` — integers, already net of reversals. */
export interface TokenBalance {
  userId: string;
  balance: number;
  lifetimeCredited: number;
  lifetimeReversed: number;
}

export interface TokenTransaction {
  id: string;
  userId: string;
  reportId: string | null;
  transactionType: 'CREDIT' | 'REVERSAL';
  amount: number;
  idempotencyKey: string;
  reason: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

/**
 * `GET /v1/analytics/summary` — every figure aggregated in SQL, never in the browser.
 *
 * `null` means "not computable yet" (nothing resolved, no analyses run) and is rendered as
 * an em dash. It never means zero. Codes with no real data must show `null` here rather than
 * a fabricated 0, so this type deliberately permits it on every derived figure.
 */
export interface AnalyticsSummary {
  scope: {
    workspace: 'REAL' | 'DEMO';
    /** Tells the reader whether this covers one student's reports or the whole campus. */
    audience: 'OWN_REPORTS' | 'WHOLE_WORKSPACE';
    generatedAt: string;
    filters: { blockId: string | null; categoryId: string | null; sinceDays: number | null };
  };
  issues: {
    total: number;
    submitted: number;
    approved: number;
    inProgress: number;
    resolved: number;
    open: number;
    overdue: number;
    unclaimed: number;
  };
  reports: {
    total: number;
    pending: number;
    aiValidated: number;
    humanValidated: number;
    duplicateValidated: number;
    rejected: number;
    decided: number;
    duplicatesLinked: number;
    duplicatesCandidate: number;
    distinctReporters: number;
  };
  resolution: {
    resolvedCount: number;
    averageHours: number | null;
    medianHours: number | null;
    averageFirstActionHours: number | null;
  };
  byBlock: { blockId: string; blockName: string; total: number; open: number; resolved: number; overdue: number }[];
  byCategory: { categoryId: string; categoryName: string; total: number; open: number; resolved: number }[];
  bySeverity: { severity: string; total: number }[];
  reportsByWeek: { weekStart: string; total: number; decided: number; duplicates: number }[];
  tokens: {
    credited: number;
    creditCount: number;
    reversed: number;
    reversalCount: number;
    studentsCredited: number;
  };
  ai: {
    analyses: number;
    succeeded: number;
    needsReview: number;
    failed: number;
    pending: number;
    disagreements: number;
    withDuplicateCandidates: number;
    averageConfidence: number | null;
    medianConfidence: number | null;
    averageLatencyMs: number | null;
    /** Shipped by the API so no consumer can mistake the score for a probability. */
    confidenceNote: string;
    models: { provider: string; model: string }[];
  };
}

/** `POST /v1/reports` — the report submission result, exactly as the server returns it. */
export interface SubmitReportResponse {
  reportId: string;
  issueId: string;
  issuePublicReference: string;
  duplicateOfExistingIssue: boolean;
  duplicateMatchStatus: string;
  tokensAwarded: number;
  tokenPolicy: { tokensPerValidatedReport: number };
  validationStatus: string;
}

/** `GET /v1/reports/:id/analysis` */
export interface ReportAnalysisResponse {
  reportId: string;
  validationStatus: string;
  duplicateMatchStatus: string;
  report: {
    selectedCategoryId: string;
    aiPredictedCategoryId: string | null;
    aiConfidence: number | null;
    aiSeverity: Severity | null;
    repairRecommendation: string | null;
  };
  analysis: {
    id: string;
    provider: string;
    model: string;
    modelVersion: string;
    status: string;
    predictedCategoryId: string | null;
    categoryMatchesChoice: boolean | null;
    confidence: number | null;
    severity: Severity | null;
    repairRecommendation: string | null;
    duplicateCandidates: { issueId: string; score: number; reason: string }[];
    requiresHumanReview: boolean;
    errorMessage: string | null;
    latencyMs: number | null;
    createdAt: string;
  } | null;
  humanReviewConfidenceThreshold: number;
}

/** `GET /v1/admin/review-queue` */
export interface ReviewQueueItem {
  analysisId: string;
  reportId: string;
  issueId: string | null;
  status: string;
  predictedCategoryId: string | null;
  selectedCategoryId: string;
  confidence: number | null;
  categoryMatchesChoice: boolean | null;
  duplicateCandidates: { issueId: string; score: number; reason: string }[];
  createdAt: string;
}

/** `GET /v1/admin/ai/status` */
export interface AiStatus {
  provider: string;
  model: string;
  modelVersion: string;
  configured: boolean;
  humanReviewConfidenceThreshold: number;
  severitySource: string;
}

/** `GET /v1/admin/users` */
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: 'STUDENT' | 'HOD' | 'ADMIN';
  accountStatus: 'ACTIVE' | 'SUSPENDED';
  department: string | null;
}

export interface AuditEntry {
  id: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  reason: string | null;
  createdAt: string;
  [key: string]: unknown;
}

export interface EventTypeContract {
  eventTypes: string[];
  deliveryMode: string;
  liveTransport: string;
  humanReviewConfidenceThreshold: number;
}
