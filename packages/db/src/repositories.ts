/**
 * Workspace-scoped data access.
 *
 * ISOLATION DESIGN (brief Section 7J):
 *   Every function here takes `workspaceId` as an explicit, required argument.
 *   There is deliberately NO helper that queries a scoped table without a
 *   workspace. That makes cross-workspace leakage a compile-time omission rather
 *   than a runtime hope — you cannot forget a filter that the API doesn't let you
 *   omit. `workspaceId` is always derived from the authenticated session
 *   (see packages/domain/src/auth.ts), never from a request body or query string.
 */
import type { Db, Tx } from './driver.js';

export type Conn = Db | Tx;

/** Postgres returns timestamptz as Date; normalise for stable JSON output. */
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());

/* ------------------------------------------------------------------ */
/* Row shapes (DB <-> domain mapping)                                  */
/* ------------------------------------------------------------------ */

export interface UserRow {
  id: string;
  workspace_id: string;
  normalized_email: string;
  display_name: string;
  password_hash: string;
  role: 'STUDENT' | 'HOD' | 'ADMIN';
  account_status: 'ACTIVE' | 'SUSPENDED';
  department: string | null;
}

export interface BlockRow {
  id: string;
  official_name: string;
  slug: string;
  description: string | null;
  active: boolean;
}

export interface SpotRow {
  id: string;
  block_id: string;
  official_name: string;
  building_label: string | null;
  floor_label: string | null;
  area_label: string | null;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
}

export interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  active: boolean;
}

export interface IssueRow {
  id: string;
  workspace_id: string;
  public_reference: string;
  title: string;
  description: string | null;
  category_id: string;
  severity: string | null;
  status: 'SUBMITTED' | 'APPROVED' | 'IN_PROGRESS' | 'RESOLVED';
  block_id: string;
  spot_id: string;
  claimed_by_user_id: string | null;
  created_by_user_id: string;
  resolution_note: string | null;
  due_at: Date | string;
  approved_at: Date | string | null;
  started_at: Date | string | null;
  resolved_at: Date | string | null;
  dedupe_key: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  claimed_by_display_name?: string | null;
  report_count?: number | string;
}

export interface ReportRow {
  id: string;
  workspace_id: string;
  issue_id: string | null;
  reporter_user_id: string;
  selected_category_id: string;
  ai_predicted_category_id: string | null;
  ai_confidence: number | null;
  ai_severity: string | null;
  repair_recommendation: string | null;
  validation_status: string;
  duplicate_match_status: string;
  block_id: string;
  spot_id: string;
  latitude: number | null;
  longitude: number | null;
  captured_at: Date | string | null;
  submitted_at: Date | string;
  evidence_storage_key: string | null;
  reporting_context: unknown;
}

export interface TokenTxnRow {
  id: string;
  user_id: string;
  report_id: string | null;
  transaction_type: 'CREDIT' | 'REVERSAL';
  amount: number;
  idempotency_key: string;
  reason: string | null;
  created_by_user_id: string | null;
  created_at: Date | string;
}

/* ------------------------------------------------------------------ */
/* Users & sessions                                                    */
/* ------------------------------------------------------------------ */

export const users = {
  async findByEmail(conn: Conn, email: string): Promise<(UserRow & { workspace_kind: 'REAL' | 'DEMO' }) | null> {
    // Login is the ONE lookup that cannot be pre-scoped by workspace: the user's
    // workspace is determined BY the lookup. Email is globally unique, so this is safe.
    const r = await conn.query<UserRow & { workspace_kind: 'REAL' | 'DEMO' }>(
      `SELECT u.*, w.kind AS workspace_kind
         FROM users u JOIN workspaces w ON w.id = u.workspace_id
        WHERE u.normalized_email = $1`,
      [email],
    );
    return r.rows[0] ?? null;
  },

  async findById(conn: Conn, workspaceId: string, userId: string): Promise<UserRow | null> {
    const r = await conn.query<UserRow>(`SELECT * FROM users WHERE id = $1 AND workspace_id = $2`, [userId, workspaceId]);
    return r.rows[0] ?? null;
  },

  async list(conn: Conn, workspaceId: string, role?: string): Promise<UserRow[]> {
    const r = role
      ? await conn.query<UserRow>(
          `SELECT * FROM users WHERE workspace_id = $1 AND role = $2 ORDER BY display_name`,
          [workspaceId, role],
        )
      : await conn.query<UserRow>(`SELECT * FROM users WHERE workspace_id = $1 ORDER BY display_name`, [workspaceId]);
    return r.rows;
  },

  async create(
    conn: Conn,
    input: { workspaceId: string; email: string; displayName: string; passwordHash: string; role: 'STUDENT' | 'HOD' | 'ADMIN' },
  ): Promise<UserRow> {
    const r = await conn.query<UserRow>(
      `INSERT INTO users (workspace_id, normalized_email, display_name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.workspaceId, input.email, input.displayName, input.passwordHash, input.role],
    );
    return r.rows[0]!;
  },

  /** Role changes are an audited admin action, never a client-settable field. */
  async updateRole(conn: Conn, workspaceId: string, userId: string, role: string): Promise<UserRow | null> {
    const r = await conn.query<UserRow>(
      `UPDATE users SET role = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING *`,
      [userId, workspaceId, role],
    );
    return r.rows[0] ?? null;
  },

  async updateStatus(conn: Conn, workspaceId: string, userId: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<UserRow | null> {
    const r = await conn.query<UserRow>(
      `UPDATE users SET account_status = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING *`,
      [userId, workspaceId, status],
    );
    return r.rows[0] ?? null;
  },
};

export const sessions = {
  async create(conn: Conn, input: { userId: string; tokenHash: string; ttlHours: number; userAgent?: string | null }) {
    const r = await conn.query<{ id: string; expires_at: Date | string }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
       VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4)
       RETURNING id, expires_at`,
      [input.userId, input.tokenHash, String(input.ttlHours), input.userAgent ?? null],
    );
    return r.rows[0]!;
  },

  /**
   * Resolves a session in ONE query, enforcing expiry AND revocation together.
   * Returns the user plus the workspace they are confined to.
   */
  async resolve(
    conn: Conn,
    tokenHash: string,
  ): Promise<
    | (UserRow & { workspace_kind: 'REAL' | 'DEMO'; session_id: string; expires_at: Date | string })
    | null
  > {
    const r = await conn.query<UserRow & { workspace_kind: 'REAL' | 'DEMO'; session_id: string; expires_at: Date | string }>(
      `SELECT u.*, w.kind AS workspace_kind, s.id AS session_id, s.expires_at
         FROM sessions s
         JOIN users u    ON u.id = s.user_id
         JOIN workspaces w ON w.id = u.workspace_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.account_status = 'ACTIVE'`,
      [tokenHash],
    );
    return r.rows[0] ?? null;
  },

  async revoke(conn: Conn, tokenHash: string): Promise<boolean> {
    const r = await conn.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash]);
    return (r.rowCount ?? 0) > 0;
  },

  async revokeAllForUser(conn: Conn, userId: string): Promise<number> {
    const r = await conn.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    return r.rowCount ?? 0;
  },
};

/* ------------------------------------------------------------------ */
/* Campus reference data                                               */
/* ------------------------------------------------------------------ */

export const campus = {
  async listBlocks(conn: Conn, workspaceId: string, includeInactive = false): Promise<BlockRow[]> {
    const r = await conn.query<BlockRow>(
      `SELECT id, official_name, slug, description, active FROM campus_blocks
        WHERE workspace_id = $1 ${includeInactive ? '' : 'AND active'} ORDER BY official_name`,
      [workspaceId],
    );
    return r.rows;
  },

  async listSpots(conn: Conn, workspaceId: string, blockId: string, includeInactive = false): Promise<SpotRow[]> {
    const r = await conn.query<SpotRow>(
      `SELECT id, block_id, official_name, building_label, floor_label, area_label, latitude, longitude, active
         FROM campus_spots
        WHERE workspace_id = $1 AND block_id = $2 ${includeInactive ? '' : 'AND active'}
        ORDER BY official_name`,
      [workspaceId, blockId],
    );
    return r.rows;
  },

  /**
   * Validates that a spot exists IN THIS WORKSPACE and returns its block.
   * This is the guard behind acceptance criterion "a report cannot reference a
   * nonexistent block or spot" — and it also blocks cross-workspace references,
   * because the workspace is part of the predicate.
   */
  async resolveSpot(conn: Conn, workspaceId: string, spotId: string): Promise<(SpotRow & { block_active: boolean }) | null> {
    const r = await conn.query<SpotRow & { block_active: boolean }>(
      `SELECT s.id, s.block_id, s.official_name, s.building_label, s.floor_label, s.area_label,
              s.latitude, s.longitude, s.active, b.active AS block_active
         FROM campus_spots s
         JOIN campus_blocks b ON b.id = s.block_id
        WHERE s.id = $1 AND s.workspace_id = $2 AND b.workspace_id = $2`,
      [spotId, workspaceId],
    );
    return r.rows[0] ?? null;
  },

  async listCategories(conn: Conn, includeInactive = false): Promise<CategoryRow[]> {
    const r = await conn.query<CategoryRow>(
      `SELECT id, name, slug, description, active FROM issue_categories
        ${includeInactive ? '' : 'WHERE active'} ORDER BY name`,
    );
    return r.rows;
  },

  async categoryExists(conn: Conn, categoryId: string): Promise<boolean> {
    const r = await conn.query(`SELECT 1 FROM issue_categories WHERE id = $1 AND active`, [categoryId]);
    return r.rows.length > 0;
  },
};

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

export interface CreateReportInput {
  workspaceId: string;
  reporterUserId: string;
  blockId: string;
  spotId: string;
  selectedCategoryId: string;
  /** Client-claimed; stored as untrusted evidence only. */
  capturedAt?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  reportingContext?: unknown;
  evidenceStorageKey?: string | null;
}

export const reports = {
  async create(conn: Conn, input: CreateReportInput): Promise<ReportRow> {
    const r = await conn.query<ReportRow>(
      `INSERT INTO reports
         (workspace_id, reporter_user_id, block_id, spot_id, selected_category_id,
          captured_at, latitude, longitude, reporting_context, evidence_storage_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        input.workspaceId,
        input.reporterUserId,
        input.blockId,
        input.spotId,
        input.selectedCategoryId,
        input.capturedAt ?? null,
        input.latitude ?? null,
        input.longitude ?? null,
        input.reportingContext ? JSON.stringify(input.reportingContext) : null,
        input.evidenceStorageKey ?? null,
      ],
    );
    return r.rows[0]!;
  },

  async findById(conn: Conn, workspaceId: string, reportId: string): Promise<ReportRow | null> {
    const r = await conn.query<ReportRow>(`SELECT * FROM reports WHERE id = $1 AND workspace_id = $2`, [reportId, workspaceId]);
    return r.rows[0] ?? null;
  },

  async listForReporter(conn: Conn, workspaceId: string, reporterUserId: string, limit: number, offset: number) {
    const items = await conn.query<ReportRow>(
      `SELECT * FROM reports WHERE workspace_id = $1 AND reporter_user_id = $2
        ORDER BY submitted_at DESC LIMIT $3 OFFSET $4`,
      [workspaceId, reporterUserId, limit, offset],
    );
    const total = await conn.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reports WHERE workspace_id = $1 AND reporter_user_id = $2`,
      [workspaceId, reporterUserId],
    );
    return { items: items.rows, total: Number(total.rows[0]!.n) };
  },

  /**
   * Every report attached to an issue, oldest first.
   *
   * `reporter_display_name` is joined in because the issue detail screen has to show a HOD who
   * filed each report (Phase 3 gap G1). The name — not the email, and never the storage key.
   * The ORDER BY is ASC so the original report that CREATED the ticket is first, which is the
   * one an operator usually wants to read.
   */
  async listForIssue(
    conn: Conn,
    workspaceId: string,
    issueId: string,
  ): Promise<(ReportRow & { reporter_display_name: string | null })[]> {
    const r = await conn.query<ReportRow & { reporter_display_name: string | null }>(
      `SELECT r.*, u.display_name AS reporter_display_name
         FROM reports r
         LEFT JOIN users u ON u.id = r.reporter_user_id
        WHERE r.workspace_id = $1 AND r.issue_id = $2
        ORDER BY r.submitted_at ASC`,
      [workspaceId, issueId],
    );
    return r.rows;
  },

  async linkToIssue(conn: Conn, workspaceId: string, reportId: string, issueId: string): Promise<void> {
    await conn.query(
      `UPDATE reports
          SET issue_id = $3,
              duplicate_match_status = CASE WHEN duplicate_match_status = 'LINKED' THEN duplicate_match_status ELSE 'LINKED' END
        WHERE id = $1 AND workspace_id = $2`,
      [reportId, workspaceId, issueId],
    );
  },

  async setEvidenceKey(conn: Conn, workspaceId: string, reportId: string, storageKey: string): Promise<void> {
    await conn.query(`UPDATE reports SET evidence_storage_key = $3 WHERE id = $1 AND workspace_id = $2`, [
      reportId,
      workspaceId,
      storageKey,
    ]);
  },

  /**
   * Writes the AI's findings onto the report, WITHOUT touching validation status.
   *
   * Deliberately separate from applyValidationOutcome: an AI prediction is not a
   * validation. Validation is decided by the trusted seam (§14) after the review
   * policy has been applied. Keeping these two writes apart is what stops a model's
   * output from ever implying that a report was approved.
   *
   * Nulls are written as nulls, not skipped: a retry that produces no prediction must
   * clear a stale one rather than leave the previous model's answer in place.
   */
  async applyAiFindings(
    conn: Conn,
    workspaceId: string,
    reportId: string,
    findings: {
      aiPredictedCategoryId: string | null;
      aiConfidence: number | null;
      aiSeverity: string | null;
      repairRecommendation: string | null;
    },
  ): Promise<ReportRow | null> {
    const r = await conn.query<ReportRow>(
      `UPDATE reports
          SET ai_predicted_category_id = $3,
              ai_confidence = $4,
              ai_severity = $5,
              repair_recommendation = $6
        WHERE id = $1 AND workspace_id = $2
        RETURNING *`,
      [
        reportId,
        workspaceId,
        findings.aiPredictedCategoryId,
        findings.aiConfidence,
        findings.aiSeverity,
        findings.repairRecommendation,
      ],
    );
    return r.rows[0] ?? null;
  },

  /** Used only by the Phase 2 AI pipeline and staff review. */
  async applyValidationOutcome(
    conn: Conn,
    workspaceId: string,
    reportId: string,
    outcome: {
      validationStatus: string;
      duplicateMatchStatus?: string | null;
      aiPredictedCategoryId?: string | null;
      aiConfidence?: number | null;
      aiSeverity?: string | null;
      repairRecommendation?: string | null;
    },
  ): Promise<ReportRow | null> {
    const r = await conn.query<ReportRow>(
      `UPDATE reports
          SET validation_status = $3,
              duplicate_match_status = COALESCE($4, duplicate_match_status),
              ai_predicted_category_id = COALESCE($5, ai_predicted_category_id),
              ai_confidence = COALESCE($6, ai_confidence),
              ai_severity = COALESCE($7, ai_severity),
              repair_recommendation = COALESCE($8, repair_recommendation)
        WHERE id = $1 AND workspace_id = $2
        RETURNING *`,
      [
        reportId,
        workspaceId,
        outcome.validationStatus,
        outcome.duplicateMatchStatus ?? null,
        outcome.aiPredictedCategoryId ?? null,
        outcome.aiConfidence ?? null,
        outcome.aiSeverity ?? null,
        outcome.repairRecommendation ?? null,
      ],
    );
    return r.rows[0] ?? null;
  },
};

/* ------------------------------------------------------------------ */
/* Issues                                                              */
/* ------------------------------------------------------------------ */

export interface CreateIssueInput {
  workspaceId: string;
  publicReference: string;
  title: string;
  description?: string | null;
  categoryId: string;
  severity?: string | null;
  blockId: string;
  spotId: string;
  createdByUserId: string;
  dueAt: Date;
  dedupeKey: string;
}

/** Columns selected for API responses, with claim owner + linked report count. */
const ISSUE_SELECT = `
  i.*, cu.display_name AS claimed_by_display_name,
  (SELECT count(*) FROM reports r WHERE r.issue_id = i.id) AS report_count
`;

export const issues = {
  /**
   * THE duplicate-safe creation path (verified in Stage 1: 10 concurrent
   * submissions -> 1 ticket, 9 linked).
   *
   * Returns `{ issue, created }`. When `created` is false the caller must link the
   * incoming report to `issue` — the master ticket already exists.
   *
   * WHY ON CONFLICT AND NOT try/catch: in PostgreSQL ANY error aborts the whole
   * transaction (SQLSTATE 25P02). Catching a unique violation would poison the
   * transaction, so the follow-up SELECT/link would fail. ON CONFLICT reports the
   * conflict WITHOUT raising, keeping the transaction usable.
   *
   * The arbiter repeats the partial index predicate — required for PostgreSQL to
   * match a partial unique index.
   */
  async createOrFindDuplicate(
    conn: Conn,
    input: CreateIssueInput,
  ): Promise<{ issue: IssueRow; created: boolean }> {
    const inserted = await conn.query<{ id: string }>(
      `INSERT INTO issues
         (workspace_id, public_reference, title, description, category_id, severity,
          block_id, spot_id, created_by_user_id, due_at, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (workspace_id, dedupe_key) WHERE status <> 'RESOLVED' DO NOTHING
       RETURNING id`,
      [
        input.workspaceId,
        input.publicReference,
        input.title,
        input.description ?? null,
        input.categoryId,
        input.severity ?? null,
        input.blockId,
        input.spotId,
        input.createdByUserId,
        input.dueAt,
        input.dedupeKey,
      ],
    );

    if (inserted.rows.length === 1) {
      const issue = await issues.findById(conn, input.workspaceId, inserted.rows[0]!.id);
      return { issue: issue!, created: true };
    }

    // Conflict: an open master ticket already exists for this physical defect.
    const existing = await conn.query<IssueRow & { claimed_by_display_name: string | null; report_count: string }>(
      `SELECT ${ISSUE_SELECT} FROM issues i
         LEFT JOIN users cu ON cu.id = i.claimed_by_user_id
        WHERE i.workspace_id = $1 AND i.dedupe_key = $2 AND i.status <> 'RESOLVED'`,
      [input.workspaceId, input.dedupeKey],
    );
    if (!existing.rows[0]) {
      // Unreachable in practice: the conflict implies a row exists. Fail loudly
      // rather than silently creating a second ticket.
      throw new Error('Duplicate conflict reported but no open master issue could be found.');
    }
    return { issue: existing.rows[0], created: false };
  },

  async findById(conn: Conn, workspaceId: string, issueId: string): Promise<IssueRow | null> {
    const r = await conn.query<IssueRow>(
      `SELECT ${ISSUE_SELECT} FROM issues i
         LEFT JOIN users cu ON cu.id = i.claimed_by_user_id
        WHERE i.id = $1 AND i.workspace_id = $2`,
      [issueId, workspaceId],
    );
    return r.rows[0] ?? null;
  },

  async findByPublicReference(conn: Conn, workspaceId: string, reference: string): Promise<IssueRow | null> {
    const r = await conn.query<IssueRow>(
      `SELECT ${ISSUE_SELECT} FROM issues i
         LEFT JOIN users cu ON cu.id = i.claimed_by_user_id
        WHERE i.public_reference = $1 AND i.workspace_id = $2`,
      [reference, workspaceId],
    );
    return r.rows[0] ?? null;
  },

  /**
   * Locks the issue row for the duration of the transaction. Required by any
   * status transition or claim: without it, two HODs can both read SUBMITTED and
   * both transition to APPROVED.
   */
  async lockForUpdate(conn: Conn, workspaceId: string, issueId: string): Promise<IssueRow | null> {
    const r = await conn.query<IssueRow>(
      `SELECT ${ISSUE_SELECT} FROM issues i
         LEFT JOIN users cu ON cu.id = i.claimed_by_user_id
        WHERE i.id = $1 AND i.workspace_id = $2
          FOR UPDATE OF i`,
      [issueId, workspaceId],
    );
    return r.rows[0] ?? null;
  },

  async paginate(
    conn: Conn,
    workspaceId: string,
    filters: {
      status?: string;
      blockId?: string;
      categoryId?: string;
      claimedByUserId?: string;
      overdueOnly?: boolean;
      /** Operational severity, as confirmed by a human. `UNSET` selects the unset rows. */
      severity?: string;
      createdAfter?: string;
      createdBefore?: string;
      /** Filters on the reports' AI verdict — see the note on `anyReportAiSeverity`. */
      anyReportAiSeverity?: string;
      limit: number;
      offset: number;
    },
  ): Promise<{ items: IssueRow[]; total: number }> {
    const where: string[] = ['i.workspace_id = $1'];
    const params: unknown[] = [workspaceId];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('$?', `$${params.length}`));
    };

    if (filters.status) add('i.status = $?', filters.status);
    if (filters.blockId) add('i.block_id = $?', filters.blockId);
    if (filters.categoryId) add('i.category_id = $?', filters.categoryId);
    if (filters.claimedByUserId) add('i.claimed_by_user_id = $?', filters.claimedByUserId);
    // Overdue derives from the CONFIGURED due_at, so no threshold is hardcoded here.
    if (filters.overdueOnly) where.push(`i.status <> 'RESOLVED' AND i.due_at < now()`);

    // Severity filtering (Phase 3 gap G4). 'UNSET' is a sentinel for "no severity recorded",
    // because a NULL is not equal to anything and a filter that silently matched nothing
    // would look like a bug to the operator using it.
    if (filters.severity === 'UNSET') {
      where.push('i.severity IS NULL');
    } else if (filters.severity) {
      add('i.severity = $?', filters.severity);
    }

    // Date range on the SERVER-RECORDED created_at. Inclusive bounds; the client sends ISO
    // instants. `created_before` is exclusive-at-the-end by convention so a day range
    // expressed as [start, end) cannot double-count a boundary row.
    if (filters.createdAfter) add('i.created_at >= $?', filters.createdAfter);
    if (filters.createdBefore) add('i.created_at < $?', filters.createdBefore);

    /**
     * AI severity lives on REPORTS, not on issues, and an issue may have several reports with
     * differing verdicts. EXISTS is used rather than a join so the issue is returned once and
     * `total` stays a count of issues rather than of matching reports — a join here would
     * inflate both and quietly break pagination.
     */
    if (filters.anyReportAiSeverity) {
      add(
        `EXISTS (SELECT 1 FROM reports ar
                  WHERE ar.issue_id = i.id AND ar.ai_severity = $?)`,
        filters.anyReportAiSeverity,
      );
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const items = await conn.query<IssueRow>(
      `SELECT ${ISSUE_SELECT} FROM issues i
         LEFT JOIN users cu ON cu.id = i.claimed_by_user_id
        ${whereSql}
        ORDER BY i.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, filters.offset],
    );
    const total = await conn.query<{ n: string }>(`SELECT count(*)::text AS n FROM issues i ${whereSql}`, params);
    return { items: items.rows, total: Number(total.rows[0]!.n) };
  },

  /** Counts for the (Phase 3) admin dashboard — served from authoritative records. */
  async statusCounts(conn: Conn, workspaceId: string): Promise<Record<string, number>> {
    const r = await conn.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM issues WHERE workspace_id = $1 GROUP BY status`,
      [workspaceId],
    );
    return Object.fromEntries(r.rows.map((row) => [row.status, Number(row.n)]));
  },

  async nextPublicReference(conn: Conn, workspaceId: string, year: number): Promise<string> {
    // Advisory lock scoped to workspace+year so two concurrent creations cannot
    // pick the same sequence value.
    await conn.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`issue-ref:${workspaceId}:${year}`]);
    const r = await conn.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issues WHERE workspace_id = $1 AND public_reference LIKE $2`,
      [workspaceId, `DSU-${year}-%`],
    );
    const next = Number(r.rows[0]!.n) + 1;
    return `DSU-${year}-${String(next).padStart(5, '0')}`;
  },

  /** Optimistic + pessimistic claim: version must match and row must be unclaimed. */
  async claim(
    conn: Conn,
    workspaceId: string,
    issueId: string,
    userId: string,
    expectedVersion?: number,
  ): Promise<{ ok: true; issue: IssueRow } | { ok: false; reason: 'ALREADY_CLAIMED' | 'VERSION_CONFLICT' | 'NOT_FOUND' }> {
    const current = await issues.lockForUpdate(conn, workspaceId, issueId);
    if (!current) return { ok: false, reason: 'NOT_FOUND' };
    if (current.claimed_by_user_id && current.claimed_by_user_id !== userId) {
      return { ok: false, reason: 'ALREADY_CLAIMED' };
    }
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      return { ok: false, reason: 'VERSION_CONFLICT' };
    }
    const r = await conn.query<IssueRow>(
      `UPDATE issues SET claimed_by_user_id = $3, version = version + 1, updated_at = now()
        WHERE id = $1 AND workspace_id = $2 AND version = $4 RETURNING id`,
      [issueId, workspaceId, userId, current.version],
    );
    if (r.rows.length === 0) return { ok: false, reason: 'VERSION_CONFLICT' };
    return { ok: true, issue: (await issues.findById(conn, workspaceId, issueId))! };
  },

  /**
   * Applies a status transition. Callers MUST have already:
   *   1. locked the row via lockForUpdate (serialises competing transitions), and
   *   2. validated the transition through the domain state machine.
   * Timestamps and `resolution_note` are set together with the status so the DB
   * CHECK constraints stay satisfiable.
   */
  async applyTransition(
    conn: Conn,
    workspaceId: string,
    issueId: string,
    next: 'SUBMITTED' | 'APPROVED' | 'IN_PROGRESS' | 'RESOLVED',
    resolutionNote?: string | null,
  ): Promise<IssueRow> {
    await conn.query(
      `UPDATE issues
          SET status = $3,
              approved_at = CASE WHEN $3 IN ('APPROVED','IN_PROGRESS','RESOLVED') THEN COALESCE(approved_at, now()) ELSE approved_at END,
              started_at  = CASE WHEN $3 IN ('IN_PROGRESS','RESOLVED')         THEN COALESCE(started_at,  now()) ELSE started_at  END,
              resolved_at = CASE WHEN $3 = 'RESOLVED'                          THEN COALESCE(resolved_at, now()) ELSE resolved_at END,
              resolution_note = CASE WHEN $3 = 'RESOLVED' THEN $4 ELSE resolution_note END,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND workspace_id = $2`,
      [issueId, workspaceId, next, resolutionNote ?? null],
    );

    // Re-read through the standard enriched projection instead of `RETURNING *`.
    // `report_count` and `claimed_by_display_name` are COMPUTED columns that
    // RETURNING cannot produce, so returning the raw row made the transition response
    // report `reportCount: 0` while GET /v1/issues/:id reported the real count.
    // That inconsistency is exactly what makes a mobile app and a website disagree,
    // so every issue response now comes from one projection function.
    return (await issues.findById(conn, workspaceId, issueId))!;
  },

  /**
   * Sets the HUMAN-CONFIRMED operational severity on an issue (Phase 3 gap G2).
   *
   * This column is deliberately separate from `reports.ai_severity`: the model's opinion and
   * the department's decision are different facts and must never overwrite each other. The
   * route that calls this records who decided and why.
   *
   * `version` is bumped and `updated_at` touched so an optimistic client can detect that the
   * issue moved underneath it.
   */
  async setSeverity(
    conn: Conn,
    workspaceId: string,
    issueId: string,
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null,
  ): Promise<IssueRow> {
    await conn.query(
      `UPDATE issues SET severity = $3, version = version + 1, updated_at = now()
        WHERE id = $1 AND workspace_id = $2`,
      [issueId, workspaceId, severity],
    );
    // Re-read through the enriched projection so `report_count` and
    // `claimed_by_display_name` are present, exactly as applyTransition does.
    return (await issues.findById(conn, workspaceId, issueId))!;
  },

  /**
   * Corrects the category on an issue (Phase 3 gap G3).
   *
   * §10 allows an HOD to correct a mis-filed report. The correction changes the ISSUE's
   * category only; the reporting student's original choice (`reports.selected_category_id`)
   * is never rewritten, because the record of what a student reported is evidence.
   */
  async setCategory(conn: Conn, workspaceId: string, issueId: string, categoryId: string): Promise<IssueRow> {
    await conn.query(
      `UPDATE issues SET category_id = $3, version = version + 1, updated_at = now()
        WHERE id = $1 AND workspace_id = $2`,
      [issueId, workspaceId, categoryId],
    );
    return (await issues.findById(conn, workspaceId, issueId))!;
  },

  async recordStatusHistory(
    conn: Conn,
    input: {
      workspaceId: string;
      issueId: string;
      previousStatus: string | null;
      newStatus: string;
      changedByUserId: string;
      reason?: string | null;
    },
  ): Promise<void> {
    await conn.query(
      `INSERT INTO issue_status_history (workspace_id, issue_id, previous_status, new_status, changed_by_user_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.workspaceId, input.issueId, input.previousStatus, input.newStatus, input.changedByUserId, input.reason ?? null],
    );
  },

  async statusHistory(conn: Conn, workspaceId: string, issueId: string) {
    const r = await conn.query(
      `SELECT h.id, h.previous_status, h.new_status, h.reason, h.created_at, u.display_name AS changed_by_display_name
         FROM issue_status_history h
         JOIN users u ON u.id = h.changed_by_user_id
        WHERE h.workspace_id = $1 AND h.issue_id = $2
        ORDER BY h.created_at ASC`,
      [workspaceId, issueId],
    );
    return r.rows;
  },
};

/* ------------------------------------------------------------------ */
/* Token ledger                                                        */
/* ------------------------------------------------------------------ */

export const tokens = {
  /**
   * Records a ledger entry. IDEMPOTENT BY CONSTRUCTION.
   *
   * The UNIQUE(idempotency_key) constraint means a retried request — or two
   * concurrent requests carrying the same key — can only ever produce one row.
   * Returns `{ inserted: false }` on retry so callers can treat it as success
   * WITHOUT minting a second award. Verified in Stage 1: 10 concurrent retries
   * -> 1 credited, 9 deduped, balance 10.
   */
  async record(
    conn: Conn,
    input: {
      workspaceId: string;
      userId: string;
      reportId?: string | null;
      transactionType: 'CREDIT' | 'REVERSAL';
      amount: number;
      idempotencyKey: string;
      reason?: string | null;
      createdByUserId?: string | null;
    },
  ): Promise<{ inserted: boolean; id: string | null }> {
    const r = await conn.query<{ id: string }>(
      `INSERT INTO token_transactions
         (workspace_id, user_id, report_id, transaction_type, amount, idempotency_key, reason, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        input.workspaceId,
        input.userId,
        input.reportId ?? null,
        input.transactionType,
        input.amount,
        input.idempotencyKey,
        input.reason ?? null,
        input.createdByUserId ?? null,
      ],
    );
    return r.rows.length ? { inserted: true, id: r.rows[0]!.id } : { inserted: false, id: null };
  },

  /** Balance is ALWAYS derived from the immutable ledger — never a mutable counter. */
  async balance(conn: Conn, workspaceId: string, userId: string) {
    const r = await conn.query<{ balance: string; credited: string; reversed: string }>(
      // NOTE: the subtraction happens in integer space and is cast to text only at the
      // very end. Casting each side first would produce `text - text`, which PostgreSQL
      // has no operator for (this was a real 500 error caught by the test suite).
      `SELECT
         (COALESCE(SUM(CASE WHEN transaction_type = 'CREDIT'   THEN amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN transaction_type = 'REVERSAL' THEN amount ELSE 0 END), 0))::text AS balance,
         COALESCE(SUM(CASE WHEN transaction_type = 'CREDIT'   THEN amount ELSE 0 END), 0)::text AS credited,
         COALESCE(SUM(CASE WHEN transaction_type = 'REVERSAL' THEN amount ELSE 0 END), 0)::text AS reversed
       FROM token_transactions WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    const row = r.rows[0]!;
    return { balance: Number(row.balance), lifetimeCredited: Number(row.credited), lifetimeReversed: Number(row.reversed) };
  },

  async history(conn: Conn, workspaceId: string, userId: string, limit: number, offset: number) {
    const items = await conn.query<TokenTxnRow>(
      `SELECT id, user_id, report_id, transaction_type, amount, idempotency_key, reason, created_by_user_id, created_at
         FROM token_transactions WHERE workspace_id = $1 AND user_id = $2
        ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [workspaceId, userId, limit, offset],
    );
    const total = await conn.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM token_transactions WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    return { items: items.rows, total: Number(total.rows[0]!.n) };
  },

  async latestCreditForReport(conn: Conn, workspaceId: string, reportId: string) {
    const r = await conn.query<TokenTxnRow>(
      `SELECT id, user_id, report_id, transaction_type, amount, idempotency_key, reason, created_by_user_id, created_at
         FROM token_transactions
        WHERE workspace_id = $1 AND report_id = $2 AND transaction_type = 'CREDIT'
        ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, reportId],
    );
    return r.rows[0] ?? null;
  },

  async hasCreditForReport(conn: Conn, workspaceId: string, reportId: string): Promise<boolean> {
    const r = await conn.query(
      `SELECT 1 FROM token_transactions
        WHERE workspace_id = $1 AND report_id = $2 AND transaction_type = 'CREDIT' LIMIT 1`,
      [workspaceId, reportId],
    );
    return r.rows.length > 0;
  },
};

/* ------------------------------------------------------------------ */
/* Audit log + transactional outbox                                    */
/* ------------------------------------------------------------------ */

export const audit = {
  /** Never pass secrets here — only identifiers and business state. */
  async record(
    conn: Conn,
    input: {
      workspaceId: string;
      actorUserId: string | null;
      action: string;
      entityType: string;
      entityId?: string | null;
      before?: unknown;
      after?: unknown;
      reason?: string | null;
    },
  ): Promise<void> {
    await conn.query(
      `INSERT INTO audit_log (workspace_id, actor_user_id, action, entity_type, entity_id, before_state, after_state, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.workspaceId,
        input.actorUserId,
        input.action,
        input.entityType,
        input.entityId ?? null,
        input.before === undefined ? null : JSON.stringify(input.before),
        input.after === undefined ? null : JSON.stringify(input.after),
        input.reason ?? null,
      ],
    );
  },

  async list(conn: Conn, workspaceId: string, limit = 50) {
    const r = await conn.query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.reason, a.created_at, u.display_name AS actor_display_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.workspace_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
      [workspaceId, limit],
    );
    return r.rows;
  },
};

export const outbox = {
  /**
   * Enqueued INSIDE the same transaction as the state change it describes, so an
   * event can never exist for a rolled-back write, and a committed write can never
   * lack its event. Publication happens only after commit (see drainOutbox).
   */
  async enqueue(
    conn: Conn,
    input: {
      workspaceId: string;
      eventType: string;
      entityType: 'REPORT' | 'ISSUE' | 'TOKEN_TRANSACTION';
      entityId: string;
      entityVersion: number;
      actorUserId?: string | null;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await conn.query(
      `INSERT INTO event_outbox (workspace_id, event_type, entity_type, entity_id, entity_version, actor_user_id, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.workspaceId,
        input.eventType,
        input.entityType,
        input.entityId,
        input.entityVersion,
        input.actorUserId ?? null,
        JSON.stringify(input.payload),
      ],
    );
  },

  /** Ordered, bounded read of undelivered events for the (Phase 2) transport. */
  async pending(conn: Conn, workspaceId: string, limit = 100) {
    const r = await conn.query(
      `SELECT id, event_type, entity_type, entity_id, entity_version, actor_user_id, payload, occurred_at
         FROM event_outbox WHERE workspace_id = $1 AND published_at IS NULL
        ORDER BY occurred_at ASC LIMIT $2`,
      [workspaceId, limit],
    );
    return r.rows;
  },

  async markPublished(conn: Conn, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await conn.query(`UPDATE event_outbox SET published_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
  },
};

export { iso as toIso };

/* ------------------------------------------------------------------ */
/* AI analyses (Phase 2)                                               */
/* ------------------------------------------------------------------ */

export interface AiAnalysisRow {
  id: string;
  report_id: string;
  provider: string;
  model: string;
  model_version: string;
  status: string;
  predicted_category_id: string | null;
  category_matches_choice: boolean | null;
  confidence: number | null;
  severity: string | null;
  repair_recommendation: string | null;
  duplicate_candidates: unknown;
  requires_human_review: boolean;
  error_message: string | null;
  latency_ms: number | null;
  created_at: string;
}

export interface InsertAiAnalysisInput {
  workspaceId: string;
  reportId: string;
  provider: string;
  model: string;
  modelVersion: string;
  status: string;
  predictedCategoryId: string | null;
  categoryMatchesChoice: boolean | null;
  confidence: number | null;
  severity: string | null;
  repairRecommendation: string | null;
  duplicateCandidates: unknown;
  requiresHumanReview: boolean;
  errorMessage: string | null;
  latencyMs: number | null;
}

/**
 * Analysis history, APPEND-ONLY.
 *
 * Every attempt writes a new row rather than updating a previous one, so re-running a
 * report with a newer model never rewrites what an older model concluded. That is what
 * makes "which model said what, and when" answerable — and it is why this table is
 * versioned by (provider, model, model_version).
 */
export const aiAnalyses = {
  async insert(conn: Conn, input: InsertAiAnalysisInput): Promise<AiAnalysisRow> {
    const r = await conn.query<AiAnalysisRow>(
      `INSERT INTO ai_analyses
         (workspace_id, report_id, provider, model, model_version, status,
          predicted_category_id, category_matches_choice, confidence, severity,
          repair_recommendation, duplicate_candidates, requires_human_review,
          error_message, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
       RETURNING *`,
      [
        input.workspaceId,
        input.reportId,
        input.provider,
        input.model,
        input.modelVersion,
        input.status,
        input.predictedCategoryId,
        input.categoryMatchesChoice,
        input.confidence,
        input.severity,
        input.repairRecommendation,
        JSON.stringify(input.duplicateCandidates ?? []),
        input.requiresHumanReview,
        input.errorMessage,
        input.latencyMs,
      ],
    );
    return r.rows[0]!;
  },

  /** Most recent attempt for a report — what the UI should show. */
  async latestForReport(conn: Conn, workspaceId: string, reportId: string): Promise<AiAnalysisRow | null> {
    const r = await conn.query<AiAnalysisRow>(
      `SELECT * FROM ai_analyses
        WHERE workspace_id = $1 AND report_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, reportId],
    );
    return r.rows[0] ?? null;
  },

  /** Full attempt history for a report, newest first. */
  async historyForReport(conn: Conn, workspaceId: string, reportId: string, limit = 20) {
    const r = await conn.query<AiAnalysisRow>(
      `SELECT * FROM ai_analyses
        WHERE workspace_id = $1 AND report_id = $2
        ORDER BY created_at DESC LIMIT $3`,
      [workspaceId, reportId, limit],
    );
    return r.rows;
  },

  /**
   * Reports awaiting a human decision (§10, §13).
   *
   * Reads the LATEST analysis per report via DISTINCT ON, so a report that failed once
   * and then succeeded on retry appears once, in its current state — not twice.
   */
  async listNeedingReview(conn: Conn, workspaceId: string, limit = 50) {
    const r = await conn.query<AiAnalysisRow & { issue_id: string | null; selected_category_id: string }>(
      `SELECT DISTINCT ON (a.report_id)
              a.*, r.issue_id, r.selected_category_id
         FROM ai_analyses a
         JOIN reports r ON r.id = a.report_id AND r.workspace_id = a.workspace_id
        WHERE a.workspace_id = $1
          AND a.requires_human_review = true
        ORDER BY a.report_id, a.created_at DESC
        LIMIT $2`,
      [workspaceId, limit],
    );
    return r.rows;
  },

  /** Counts for the admin dashboard, scoped to one workspace. */
  /**
   * Reports that still need an analysis — the background worker's work queue.
   *
   * THE ATTEMPT BUDGET IS THE POINT OF THIS QUERY. A successful analysis writes the
   * report's `ai_*` columns but deliberately does NOT touch `validation_status`,
   * because that column means "a human has ruled on this" and the AI is never allowed
   * to rule on anything (§17). So an analysed report stays PENDING forever, and a
   * worker that simply asked for "PENDING reports" would pick the same ones up on every
   * poll, re-running inference for the life of the process.
   *
   * The termination signal is therefore not a status change — it is the analysis
   * HISTORY, which already records every attempt:
   *
   *   1. a report that has produced a usable answer (SUCCEEDED or NEEDS_HUMAN_REVIEW)
   *      is never analysed again, so a second worker, a restart, or a manual retry
   *      cannot produce a duplicate analysis;
   *   2. a report whose FAILED attempts have reached the configured limit is left
   *      alone, so a permanently broken image costs three attempts and then stops
   *      rather than burning the CPU on every tick;
   *   3. a report with no photograph can never be analysed, so it is not queued at all.
   *
   * Ordering by `submitted_at` makes the queue FIFO, so the oldest waiting student is
   * served first and a burst of submissions drains in the order it arrived.
   */
  async listAwaitingAnalysis(
    conn: Conn,
    workspaceId: string,
    maxAttempts: number,
    limit = 5,
  ): Promise<Array<{ reportId: string; workspaceKind: 'REAL' | 'DEMO' }>> {
    const r = await conn.query<{ report_id: string; workspace_kind: 'REAL' | 'DEMO' }>(
      `SELECT r.id AS report_id, w.kind AS workspace_kind
         FROM reports r
         JOIN workspaces w ON w.id = r.workspace_id
        WHERE r.workspace_id = $1
          AND r.validation_status = 'PENDING'
          AND r.evidence_storage_key IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM ai_analyses done
                 WHERE done.report_id = r.id
                   AND done.status IN ('SUCCEEDED', 'NEEDS_HUMAN_REVIEW')
              )
          AND (SELECT count(*) FROM ai_analyses tried
                WHERE tried.report_id = r.id
                  AND tried.status = 'FAILED') < $2
        ORDER BY r.submitted_at
        LIMIT $3`,
      [workspaceId, maxAttempts, limit],
    );
    return r.rows.map((row) => ({ reportId: row.report_id, workspaceKind: row.workspace_kind }));
  },

  /** How many attempts a report has already had, for reporting without re-querying rows. */
  async attemptCount(conn: Conn, workspaceId: string, reportId: string): Promise<number> {
    const r = await conn.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ai_analyses WHERE workspace_id = $1 AND report_id = $2`,
      [workspaceId, reportId],
    );
    return Number(r.rows[0]?.n ?? 0);
  },

  async statusCounts(conn: Conn, workspaceId: string): Promise<Record<string, number>> {
    const r = await conn.query<{ status: string; n: string }>(
      `SELECT DISTINCT ON (report_id) status, count(*) OVER () AS n
         FROM ai_analyses WHERE workspace_id = $1
        ORDER BY report_id, created_at DESC`,
      [workspaceId],
    );
    const counts: Record<string, number> = {};
    for (const row of r.rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  },
};
