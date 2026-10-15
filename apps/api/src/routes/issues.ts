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
  TransitionReasonSchema,
} from '@campus/contracts';
import { claimIssue, getIssue, listIssues, transitionIssue } from '@campus/domain';
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
