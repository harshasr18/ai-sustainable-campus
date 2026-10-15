/**
 * Issue queue and lifecycle endpoints.
 *
 * There is NO generic "update issue" route and no PATCH accepting a `status` field.
 * Each legal change is its own explicit endpoint, so the set of reachable states is
 * exactly the state machine's transition table — nothing more (brief Section 9).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ClaimIssueRequestSchema,
  ListIssuesQuerySchema,
  ResolveIssueRequestSchema,
  SetIssueCategoryRequestSchema,
  SetIssueSeverityRequestSchema,
  TransitionReasonSchema,
} from '@campus/contracts';
import {
  claimIssue,
  getIssue,
  listIssues,
  setIssueCategory,
  setIssueSeverity,
  transitionIssue,
} from '@campus/domain';
import { issues as issueRepo, type Db } from '@campus/db';
import { actorOf, requireAuth } from '../auth-plugin.js';

const IssueIdParamsSchema = z.object({ id: z.uuid() });

export function registerIssueRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  /* ---------------------------------------------------------------- */
  /* GET /v1/issues — operational queue (HOD/ADMIN only)              */
  /* ---------------------------------------------------------------- */
  app.get(
    '/v1/issues',
    { preHandler: requireAuth(db, 'HOD', 'ADMIN'), schema: { querystring: ListIssuesQuerySchema } },
    async (request) => {
      const actor = actorOf(request);
      const q = request.query as z.infer<typeof ListIssuesQuerySchema>;
      const { items, total } = await listIssues(db, actor, q);
      return { items, total, limit: q.limit, offset: q.offset };
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /v1/issues/:id — accepts a UUID or a public reference        */
  /* ---------------------------------------------------------------- */
  app.get('/v1/issues/:id', { preHandler: requireAuth(db) }, async (request) => {
    const actor = actorOf(request);
    const raw = (request.params as { id: string }).id;

    // Students may look up an issue ONLY through reports they own, so we resolve by
    // reference/id and then check ownership for STUDENT callers.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
    const row = isUuid
      ? await issueRepo.findById(db, actor.workspaceId, raw)
      : await issueRepo.findByPublicReference(db, actor.workspaceId, raw);

    if (!row) return { issue: null };

    if (actor.role === 'STUDENT') {
      // A student may only see a master issue if they filed one of its reports.
      const theirReports = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM reports WHERE workspace_id = $1 AND issue_id = $2 AND reporter_user_id = $3`,
        [actor.workspaceId, row.id, actor.userId],
      );
      if (Number(theirReports.rows[0]!.n) === 0) {
        // Do not confirm the issue exists to a student who cannot see it.
        return { issue: null };
      }
    }

    const detail = await getIssue(db, actor, row.id);

    /**
     * The reports attached to this ticket (Phase 3, audit gap G1).
     *
     * `getIssue` already loaded them; the route was only returning their count, which left
     * the HOD workflow unable to reach a photograph and therefore unable to validate
     * anything. Nothing new is queried — the rows were being fetched and discarded.
     *
     * What is exposed is deliberately narrow. `evidence_storage_key` is NOT included: the
     * storage key is an internal detail and the bytes are served only through the
     * authorization-gated `/v1/reports/:id/evidence`. The reporter's identity is reduced to a
     * display name; a student reading their own issue sees "another student", not an email.
     */
    const visibleReports =
      actor.role === 'STUDENT'
        ? detail.linkedReports.filter((r) => r.reporter_user_id === actor.userId)
        : detail.linkedReports;

    const linkedReports = visibleReports.map((r) => ({
      id: r.id,
      /**
       * A student sees ONLY their own report here, and no other reporter's identity at all.
       * "Three students reported this" is useful; who they were is not the student's business,
       * and `canReadEvidence` would refuse the photographs anyway. The count below still
       * reveals that others exist, which the duplicate-linking UX needs.
       */
      reporterUserId: actor.role === 'STUDENT' ? null : r.reporter_user_id,
      reporterDisplayName: actor.role === 'STUDENT' ? null : (r.reporter_display_name ?? null),
      selectedCategoryId: r.selected_category_id,
      aiPredictedCategoryId: r.ai_predicted_category_id,
      aiConfidence: r.ai_confidence,
      aiSeverity: r.ai_severity,
      validationStatus: r.validation_status,
      duplicateMatchStatus: r.duplicate_match_status,
      submittedAt: new Date(r.submitted_at).toISOString(),
      hasEvidence: Boolean(r.evidence_storage_key),
      evidenceUrl: r.evidence_storage_key ? `/v1/reports/${r.id}/evidence` : null,
    }));

    return {
      issue: detail.issue,
      history: detail.history.map((h: Record<string, unknown>) => ({
        id: h.id,
        previousStatus: h.previous_status,
        newStatus: h.new_status,
        reason: h.reason,
        changedByDisplayName: h.changed_by_display_name,
        createdAt: h.created_at,
      })),
      linkedReports,
      /** The true number of reports on the ticket, even for a student who sees only one. */
      linkedReportCount: detail.linkedReports.length,
    };
  });

  /* ---------------------------------------------------------------- */
  /* POST /v1/issues/:id/claim                                        */
  /* ---------------------------------------------------------------- */
  app.post(
    '/v1/issues/:id/claim',
    {
      preHandler: requireAuth(db, 'HOD', 'ADMIN'),
      schema: { params: IssueIdParamsSchema, body: ClaimIssueRequestSchema },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IssueIdParamsSchema>;
      const body = request.body as z.infer<typeof ClaimIssueRequestSchema>;
      const result = await claimIssue(db, actor, { issueId: id, expectedVersion: body.expectedVersion });
      return { issue: result.issue };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Explicit lifecycle transitions                                   */
  /* ---------------------------------------------------------------- */

  const transition = (path: string, to: 'APPROVED' | 'IN_PROGRESS') =>
    app.post(
      path,
      {
        preHandler: requireAuth(db, 'HOD', 'ADMIN'),
        schema: { params: IssueIdParamsSchema, body: TransitionReasonSchema },
      },
      async (request) => {
        const actor = actorOf(request);
        const { id } = request.params as z.infer<typeof IssueIdParamsSchema>;
        const body = request.body as z.infer<typeof TransitionReasonSchema>;
        const result = await transitionIssue(db, actor, { issueId: id, to, reason: body.reason });
        return { issue: result.issue };
      },
    );

  transition('/v1/issues/:id/approve', 'APPROVED');
  transition('/v1/issues/:id/start', 'IN_PROGRESS');

  /* ---------------------------------------------------------------- */
  /* Operational fields: severity and category                        */
  /* ---------------------------------------------------------------- */

  /**
   * These are PATCHes on NAMED FIELDS, not a generic "update issue" route. There is still no
   * endpoint that accepts a `status` — that remains the exclusive job of the four explicit
   * transition routes above, each of which runs the state machine. Closes gaps G2 and G3.
   *
   * Both require a reason to be *offerable* but not mandatory; both write history-grade audit
   * rows and publish an event, in the same transaction as the change.
   */
  app.patch(
    '/v1/issues/:id/severity',
    {
      preHandler: requireAuth(db, 'HOD', 'ADMIN'),
      schema: { params: IssueIdParamsSchema, body: SetIssueSeverityRequestSchema },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IssueIdParamsSchema>;
      const body = request.body as z.infer<typeof SetIssueSeverityRequestSchema>;
      const result = await setIssueSeverity(db, actor, {
        issueId: id,
        severity: body.severity,
        reason: body.reason,
      });
      return { issue: result.issue, previousSeverity: result.previousSeverity };
    },
  );

  app.patch(
    '/v1/issues/:id/category',
    {
      preHandler: requireAuth(db, 'HOD', 'ADMIN'),
      schema: { params: IssueIdParamsSchema, body: SetIssueCategoryRequestSchema },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IssueIdParamsSchema>;
      const body = request.body as z.infer<typeof SetIssueCategoryRequestSchema>;
      const result = await setIssueCategory(db, actor, {
        issueId: id,
        categoryId: body.categoryId,
        reason: body.reason,
      });
      return { issue: result.issue, previousCategoryId: result.previousCategoryId };
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /v1/issues/:id/resolve — completion note required           */
  /* ---------------------------------------------------------------- */
  app.post(
    '/v1/issues/:id/resolve',
    {
      preHandler: requireAuth(db, 'HOD', 'ADMIN'),
      schema: { params: IssueIdParamsSchema, body: ResolveIssueRequestSchema },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IssueIdParamsSchema>;
      const body = request.body as z.infer<typeof ResolveIssueRequestSchema>;
      const result = await transitionIssue(db, actor, {
        issueId: id,
        to: 'RESOLVED',
        resolutionNote: body.resolutionNote,
      });
      return { issue: result.issue };
    },
  );
}
