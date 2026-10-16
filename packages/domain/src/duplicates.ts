/**
 * Duplicate handling beyond the deterministic rule.
 *
 * THE DETERMINISTIC RULE (unchanged, dedupe.ts + ux_issues_dedupe_active): a report at the
 * same named spot with the same category as an open issue is linked to it at submission
 * time, inside the database constraint, safe under concurrency. That is a CONFIRMED match.
 *
 * WHAT THIS FILE ADDS: the uncertain cases the deterministic rule cannot see, turned into
 * SUGGESTIONS that a human confirms or dismisses. A suggestion never links, merges or
 * credits anything by itself.
 *
 * The rule is explicit and multi-signal. It runs only for a report that opened its own
 * ticket, and only inside the same block — a similar photo in another building is never a
 * candidate. Two shapes:
 *
 *   SAME_SPOT_AI_CATEGORY — same named spot; the student chose category X, but the vision
 *     model classified the photo as Y, and an open issue for Y already exists at that
 *     spot. Signals: same block, same spot, model category = candidate category.
 *
 *   SAME_BLOCK_SAME_CATEGORY_RECENT — same block, a DIFFERENT named spot, the same category,
 *     and the candidate was opened within the last 72 hours. Students describe one place
 *     differently ("corridor" vs "outside room 101"); this asks a human whether that
 *     happened. Signals: same block, same category, recency.
 *
 * WHAT IT DELIBERATELY DOES NOT USE: image-embedding similarity. The current model is used
 * for zero-shot classification only, embeddings are not stored, and a similarity score was
 * never measured on campus photos — so no score is computed or shown. Each suggestion
 * records the boolean signals that fired, which is the honest content of the match.
 */
import type { Actor } from './issues.js';
import {
  audit as auditRepo,
  issues as issueRepo,
  type Conn,
  type Db,
  type ReportRow,
} from '@campus/db';
import { forbidden, invalidTransition, notFound, validationFailed } from './errors.js';
import { outboxPublisher } from './adapters/realtime.js';

export type DuplicateReasonCode = 'SAME_SPOT_AI_CATEGORY' | 'SAME_BLOCK_SAME_CATEGORY_RECENT';

/** Hours within which a different-spot, same-category issue is considered "recent". */
export const NEARBY_DUPLICATE_WINDOW_HOURS = 72;

/** Source states from which a ticket may still be merged: no repair work has started. */
const MERGEABLE_SOURCE_STATUSES = ['SUBMITTED', 'APPROVED'] as const;

export interface DuplicateSuggestionRow {
  id: string;
  report_id: string;
  source_issue_id: string;
  candidate_issue_id: string;
  reason_code: DuplicateReasonCode;
  signals: Record<string, unknown>;
  status: 'OPEN' | 'CONFIRMED' | 'DISMISSED' | 'SUPERSEDED';
  created_at: Date;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  candidate_public_reference: string;
  candidate_status: string;
  candidate_spot_name: string | null;
  candidate_category_name: string | null;
  candidate_report_count: number;
  source_public_reference: string;
}

export interface DuplicateSuggestionDto {
  id: string;
  reportId: string;
  sourceIssueId: string;
  sourceIssueReference: string;
  candidateIssueId: string;
  candidateIssueReference: string;
  candidateStatus: string;
  candidateSpotName: string | null;
  candidateCategoryName: string | null;
  candidateReportCount: number;
  reasonCode: DuplicateReasonCode;
  signals: Record<string, unknown>;
  status: DuplicateSuggestionRow['status'];
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export function toSuggestionDto(r: DuplicateSuggestionRow): DuplicateSuggestionDto {
  return {
    id: r.id,
    reportId: r.report_id,
    sourceIssueId: r.source_issue_id,
    sourceIssueReference: r.source_public_reference,
    candidateIssueId: r.candidate_issue_id,
    candidateIssueReference: r.candidate_public_reference,
    candidateStatus: r.candidate_status,
    candidateSpotName: r.candidate_spot_name,
    candidateCategoryName: r.candidate_category_name,
    candidateReportCount: Number(r.candidate_report_count),
    reasonCode: r.reason_code,
    signals: r.signals,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    decisionNote: r.decision_note,
  };
}

const SUGGESTION_SELECT = `
  SELECT s.*,
         ci.public_reference AS candidate_public_reference,
         ci.status           AS candidate_status,
         csp.official_name   AS candidate_spot_name,
         cc.name             AS candidate_category_name,
         (SELECT count(*) FROM reports r WHERE r.issue_id = ci.id)::int AS candidate_report_count,
         si.public_reference AS source_public_reference
    FROM duplicate_suggestions s
    JOIN issues ci ON ci.id = s.candidate_issue_id
    JOIN issues si ON si.id = s.source_issue_id
    LEFT JOIN campus_spots csp ON csp.id = ci.spot_id
    LEFT JOIN issue_categories cc ON cc.id = ci.category_id`;

/** Every OPEN suggestion in the workspace, newest first — the HOD's duplicate review list. */
export async function listOpenSuggestions(conn: Conn, workspaceId: string, limit = 100) {
  const r = await conn.query<DuplicateSuggestionRow>(
    `${SUGGESTION_SELECT}
      WHERE s.workspace_id = $1 AND s.status = 'OPEN'
        AND si.status NOT IN ('RESOLVED','DUPLICATE') AND ci.status NOT IN ('RESOLVED','DUPLICATE')
      ORDER BY s.created_at DESC
      LIMIT $2`,
    [workspaceId, limit],
  );
  return r.rows.map(toSuggestionDto);
}

/** Suggestions touching an issue (as the ticket under review, or as the proposed master). */
export async function listSuggestionsForIssue(conn: Conn, workspaceId: string, issueId: string) {
  const r = await conn.query<DuplicateSuggestionRow>(
    `${SUGGESTION_SELECT}
      WHERE s.workspace_id = $1 AND (s.source_issue_id = $2 OR s.candidate_issue_id = $2)
      ORDER BY (s.status = 'OPEN') DESC, s.created_at DESC`,
    [workspaceId, issueId],
  );
  return r.rows.map(toSuggestionDto);
}

export async function listOpenSuggestionsForReports(conn: Conn, workspaceId: string, reportIds: string[]) {
  if (reportIds.length === 0) return [];
  const r = await conn.query<DuplicateSuggestionRow>(
    `${SUGGESTION_SELECT}
      WHERE s.workspace_id = $1 AND s.status = 'OPEN' AND s.report_id = ANY($2::uuid[])
      ORDER BY s.created_at DESC`,
    [workspaceId, reportIds],
  );
  return r.rows.map(toSuggestionDto);
}

/**
 * Finds and records suggestions for a freshly analysed report. Runs INSIDE the analysis
 * transaction so the suggestions, the report's duplicate status and the analysis row
 * commit together. Returns the number of OPEN suggestions now on the report.
 */
export async function recordDuplicateSuggestions(
  tx: Conn,
  input: {
    workspaceId: string;
    workspaceKind: 'REAL' | 'DEMO';
    report: ReportRow;
    predictedCategoryId: string | null;
    aiConfidence: number | null;
  },
): Promise<number> {
  const { report } = input;
  // Only a report that opened its own ticket can be a hidden duplicate; a LINKED report is
  // already attached to its master by the deterministic rule.
  if (report.duplicate_match_status !== 'NOT_CHECKED' || !report.issue_id) return 0;

  const own = await tx.query<{ status: string }>(`SELECT status FROM issues WHERE id = $1 AND workspace_id = $2`, [
    report.issue_id,
    input.workspaceId,
  ]);
  if (!own.rows[0] || !(MERGEABLE_SOURCE_STATUSES as readonly string[]).includes(own.rows[0].status)) {
    await setMatchStatus(tx, input.workspaceId, report.id, 'NO_MATCH');
    return 0;
  }

  const candidates = await tx.query<{ id: string; reason_code: DuplicateReasonCode; same_spot: boolean }>(
    `SELECT i.id,
            CASE WHEN i.spot_id = $3 THEN 'SAME_SPOT_AI_CATEGORY' ELSE 'SAME_BLOCK_SAME_CATEGORY_RECENT' END AS reason_code,
            (i.spot_id = $3) AS same_spot
       FROM issues i
      WHERE i.workspace_id = $1
        AND i.block_id = $2
        AND i.id <> $4
        AND i.status NOT IN ('RESOLVED', 'DUPLICATE')
        -- No mirrored pair: if that ticket already has an OPEN suggestion pointing at THIS
        -- ticket, the HOD's one decision covers both directions. (Found in the live probe:
        -- two reports analysed in one sweep each suggested the other.)
        AND NOT EXISTS (
              SELECT 1 FROM duplicate_suggestions d
               WHERE d.workspace_id = $1 AND d.status = 'OPEN'
                 AND d.source_issue_id = i.id AND d.candidate_issue_id = $4)
        AND (
              -- same spot, the MODEL's category (which differs from the student's) is open there
              ($5::uuid IS NOT NULL AND $5::uuid <> $6::uuid AND i.spot_id = $3 AND i.category_id = $5::uuid)
           OR -- different spot in the same block, same student category, opened recently
              (i.spot_id <> $3 AND i.category_id = $6::uuid
               AND i.created_at >= now() - make_interval(hours => $7::int))
        )
      ORDER BY (i.spot_id = $3) DESC, i.created_at DESC
      LIMIT 5`,
    [
      input.workspaceId,
      report.block_id,
      report.spot_id,
      report.issue_id,
      input.predictedCategoryId,
      report.selected_category_id,
      NEARBY_DUPLICATE_WINDOW_HOURS,
    ],
  );

  for (const c of candidates.rows) {
    const signals =
      c.reason_code === 'SAME_SPOT_AI_CATEGORY'
        ? {
            sameBlock: true,
            sameSpot: true,
            modelCategoryMatchesCandidate: true,
            studentCategoryMatchesCandidate: false,
            modelConfidence: input.aiConfidence,
          }
        : {
            sameBlock: true,
            sameSpot: false,
            studentCategoryMatchesCandidate: true,
            modelCategoryMatchesCandidate: input.predictedCategoryId === report.selected_category_id,
            withinHours: NEARBY_DUPLICATE_WINDOW_HOURS,
          };
    await tx.query(
      `INSERT INTO duplicate_suggestions
         (workspace_id, report_id, source_issue_id, candidate_issue_id, reason_code, signals)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (report_id, candidate_issue_id) DO NOTHING`,
      [input.workspaceId, report.id, report.issue_id, c.id, c.reason_code, JSON.stringify(signals)],
    );
  }

  const open = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM duplicate_suggestions WHERE report_id = $1 AND status = 'OPEN'`,
    [report.id],
  );
  const n = open.rows[0]!.n;

  await setMatchStatus(tx, input.workspaceId, report.id, n > 0 ? 'CANDIDATE_FOUND' : 'NO_MATCH');
  if (n > 0) {
    await outboxPublisher.publish(tx, {
      eventType: 'report.duplicate_candidate_found',
      workspaceId: input.workspaceId,
      workspace: input.workspaceKind,
      entityType: 'REPORT',
      entityId: report.id,
      entityVersion: 1,
      actorUserId: null,
      payload: { reportId: report.id, issueId: report.issue_id, candidateCount: n },
    });
  }
  return n;
}

async function setMatchStatus(tx: Conn, workspaceId: string, reportId: string, status: string) {
  await tx.query(`UPDATE reports SET duplicate_match_status = $3 WHERE id = $1 AND workspace_id = $2`, [
    reportId,
    workspaceId,
    status,
  ]);
}

function assertStaff(actor: Actor) {
  if (actor.role !== 'HOD' && actor.role !== 'ADMIN') {
    throw forbidden('Only an HOD or ADMIN can decide duplicate suggestions.');
  }
}

async function lockSuggestion(tx: Conn, workspaceId: string, suggestionId: string) {
  const r = await tx.query<DuplicateSuggestionRow>(
    `SELECT * FROM duplicate_suggestions WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
    [suggestionId, workspaceId],
  );
  const s = r.rows[0];
  if (!s) throw notFound('Duplicate suggestion not found.');
  if (s.status !== 'OPEN') throw invalidTransition(`This suggestion was already ${s.status.toLowerCase()}.`);
  return s;
}

/**
 * HOD confirms: the report's ticket IS the same defect as the candidate. The ticket is
 * merged into the candidate — every report on it moves to the master, the ticket becomes
 * DUPLICATE (terminal, history kept, pointer to the master), and the master's deadline
 * becomes the earlier of the two so the 72-hour clock still starts at the first report.
 * Token credits are untouched: each report keeps whatever it already earned.
 */
export async function confirmDuplicateSuggestion(
  db: Db,
  actor: Actor,
  input: { suggestionId: string; note?: string | null },
) {
  assertStaff(actor);
  return db.withTransaction(async (tx) => {
    const s = await lockSuggestion(tx, actor.workspaceId, input.suggestionId);

    // Lock both tickets in a stable order so two merges can never deadlock.
    const [first, second] = [s.source_issue_id, s.candidate_issue_id].sort();
    const a = await issueRepo.lockForUpdate(tx, actor.workspaceId, first!);
    const b = await issueRepo.lockForUpdate(tx, actor.workspaceId, second!);
    const source = a?.id === s.source_issue_id ? a : b;
    const target = a?.id === s.candidate_issue_id ? a : b;
    if (!source || !target) throw notFound('One of the issues no longer exists.');

    if (!(MERGEABLE_SOURCE_STATUSES as readonly string[]).includes(source.status)) {
      throw invalidTransition(
        `${source.public_reference} is ${source.status}; only a ticket on which work has not started can be merged.`,
      );
    }
    if (target.status === 'RESOLVED' || target.status === 'DUPLICATE') {
      throw invalidTransition(`${target.public_reference} is ${target.status} and cannot receive more reports.`);
    }
    if (source.block_id !== target.block_id) {
      throw validationFailed('Issues in different blocks are never merged.');
    }

    const moved = await tx.query<{ id: string }>(
      `UPDATE reports SET issue_id = $3, duplicate_match_status = 'LINKED'
        WHERE workspace_id = $1 AND issue_id = $2 RETURNING id`,
      [actor.workspaceId, source.id, target.id],
    );

    const merged = await tx.query<{ version: number }>(
      `UPDATE issues SET status = 'DUPLICATE', duplicate_of_issue_id = $3, version = version + 1, updated_at = now()
        WHERE id = $1 AND workspace_id = $2 RETURNING version`,
      [source.id, actor.workspaceId, target.id],
    );
    const master = await tx.query<{ version: number }>(
      `UPDATE issues SET due_at = LEAST(due_at, $3::timestamptz), version = version + 1, updated_at = now()
        WHERE id = $1 AND workspace_id = $2 RETURNING version`,
      [target.id, actor.workspaceId, source.due_at],
    );

    const note = input.note?.trim() || null;
    await issueRepo.recordStatusHistory(tx, {
      workspaceId: actor.workspaceId,
      issueId: source.id,
      previousStatus: source.status,
      newStatus: 'DUPLICATE',
      changedByUserId: actor.userId,
      reason: `Merged into ${target.public_reference}${note ? ` — ${note}` : ''}`,
    });

    await tx.query(
      `UPDATE duplicate_suggestions
          SET status = CASE WHEN id = $2 THEN 'CONFIRMED' ELSE 'SUPERSEDED' END,
              decided_by_user_id = $3, decided_at = now(), decision_note = CASE WHEN id = $2 THEN $4 ELSE decision_note END
        WHERE workspace_id = $1 AND status = 'OPEN'
          -- the decided one, every other suggestion ABOUT the merged ticket, and every
          -- suggestion that proposed the merged ticket as a master (it no longer is one)
          AND (id = $2 OR source_issue_id = $5 OR candidate_issue_id = $5)`,
      [actor.workspaceId, s.id, actor.userId, note, source.id],
    );

    await auditRepo.record(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: 'issue.merged_as_duplicate',
      entityType: 'ISSUE',
      entityId: source.id,
      before: { status: source.status, reports: moved.rows.length },
      after: { status: 'DUPLICATE', duplicateOfIssueId: target.id, movedReportIds: moved.rows.map((r) => r.id) },
      reason: note,
    });

    await outboxPublisher.publish(tx, {
      eventType: 'issue.status_changed',
      workspaceId: actor.workspaceId,
      workspace: actor.workspaceKind,
      entityType: 'ISSUE',
      entityId: source.id,
      entityVersion: merged.rows[0]!.version,
      actorUserId: actor.userId,
      payload: { issueId: source.id, from: source.status, to: 'DUPLICATE', duplicateOfIssueId: target.id },
    });
    for (const r of moved.rows) {
      await outboxPublisher.publish(tx, {
        eventType: 'report.linked_to_master_issue',
        workspaceId: actor.workspaceId,
        workspace: actor.workspaceKind,
        entityType: 'REPORT',
        entityId: r.id,
        entityVersion: 1,
        actorUserId: actor.userId,
        payload: { reportId: r.id, fromIssueId: source.id, issueId: target.id, masterVersion: master.rows[0]!.version },
      });
    }

    return {
      suggestionId: s.id,
      mergedIssueId: source.id,
      mergedIssueReference: source.public_reference,
      masterIssueId: target.id,
      masterIssueReference: target.public_reference,
      movedReportIds: moved.rows.map((r) => r.id),
    };
  });
}

/** HOD dismisses: the two tickets are different defects. Nothing is moved. */
export async function dismissDuplicateSuggestion(
  db: Db,
  actor: Actor,
  input: { suggestionId: string; note?: string | null },
) {
  assertStaff(actor);
  return db.withTransaction(async (tx) => {
    const s = await lockSuggestion(tx, actor.workspaceId, input.suggestionId);
    const note = input.note?.trim() || null;
    await tx.query(
      `UPDATE duplicate_suggestions SET status = 'DISMISSED', decided_by_user_id = $2, decided_at = now(), decision_note = $3
        WHERE id = $1`,
      [s.id, actor.userId, note],
    );
    const remaining = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM duplicate_suggestions WHERE report_id = $1 AND status = 'OPEN'`,
      [s.report_id],
    );
    if (remaining.rows[0]!.n === 0) {
      await setMatchStatus(tx, actor.workspaceId, s.report_id, 'HUMAN_OVERRIDDEN');
    }
    await auditRepo.record(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: 'report.duplicate_dismissed',
      entityType: 'REPORT',
      entityId: s.report_id,
      before: { suggestion: 'OPEN', candidateIssueId: s.candidate_issue_id },
      after: { suggestion: 'DISMISSED' },
      reason: note,
    });
    await outboxPublisher.publish(tx, {
      eventType: 'report.duplicate_rejected',
      workspaceId: actor.workspaceId,
      workspace: actor.workspaceKind,
      entityType: 'REPORT',
      entityId: s.report_id,
      entityVersion: 1,
      actorUserId: actor.userId,
      payload: { reportId: s.report_id, candidateIssueId: s.candidate_issue_id, suggestionId: s.id },
    });
    return { suggestionId: s.id, remainingOpen: remaining.rows[0]!.n };
  });
}
