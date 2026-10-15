/**
 * Row -> API DTO mapping. Kept in ONE place so the mobile app and the admin website
 * are guaranteed to receive identical shapes for identical records.
 */
import type { Issue, Report } from '@campus/contracts';
import type { IssueRow, ReportRow } from '@campus/db';
import { toIso } from '@campus/db';

export function toIssueDto(row: IssueRow, now: Date = new Date()): Issue {
  const dueAt = toIso(row.due_at)!;
  return {
    id: row.id,
    publicReference: row.public_reference,
    title: row.title,
    description: row.description,
    categoryId: row.category_id,
    severity: (row.severity as Issue['severity']) ?? null,
    status: row.status,
    blockId: row.block_id,
    spotId: row.spot_id,
    claimedByUserId: row.claimed_by_user_id,
    claimedByDisplayName: row.claimed_by_display_name ?? null,
    createdByUserId: row.created_by_user_id,
    approvedAt: toIso(row.approved_at),
    startedAt: toIso(row.started_at),
    resolvedAt: toIso(row.resolved_at),
    resolutionNote: row.resolution_note,
    dueAt,
    // Derived from the CONFIGURED due_at; no threshold is hardcoded in a client.
    overdue: row.status !== 'RESOLVED' && new Date(dueAt).getTime() < now.getTime(),
    version: row.version,
    reportCount: Number(row.report_count ?? 0),
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

export interface ReportDtoExtras {
  /** Whether evidence bytes are actually stored for this report. */
  hasEvidence: boolean;
  evidenceUrl: string | null;
  tokenEligible: boolean;
  tokensAwarded: number;
}

export function toReportDto(row: ReportRow, extras: ReportDtoExtras): Report {
  return {
    id: row.id,
    issueId: row.issue_id,
    reporterUserId: row.reporter_user_id,
    selectedCategoryId: row.selected_category_id,
    aiPredictedCategoryId: row.ai_predicted_category_id,
    aiConfidence: row.ai_confidence,
    aiSeverity: (row.ai_severity as Report['aiSeverity']) ?? null,
    repairRecommendation: row.repair_recommendation,
    validationStatus: row.validation_status as Report['validationStatus'],
    duplicateMatchStatus: row.duplicate_match_status as Report['duplicateMatchStatus'],
    blockId: row.block_id,
    spotId: row.spot_id,
    latitude: row.latitude,
    longitude: row.longitude,
    capturedAt: toIso(row.captured_at),
    submittedAt: toIso(row.submitted_at)!,
    hasEvidence: extras.hasEvidence,
    evidenceUrl: extras.evidenceUrl,
    tokenEligible: extras.tokenEligible,
    tokensAwarded: extras.tokensAwarded,
  };
}
