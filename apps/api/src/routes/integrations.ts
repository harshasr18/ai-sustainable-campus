/**
 * Integration boundaries: AI analysis, event stream, and operational diagnostics.
 *
 * HONEST STATUS: AI analysis and the live event stream are NOT implemented in
 * Phase 1. These endpoints exist so the contract is explicit and the clients can be
 * written against it, and they return HTTP 501 NOT_IMPLEMENTED with a clear message.
 *
 * They deliberately do NOT return plausible-looking fake data. A stubbed AI response
 * would let a client believe an issue was analysed and could trigger unearned token
 * awards, poisoning the ledger with fiction.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AI_REVIEW_CONFIDENCE_THRESHOLD, EVENT_TYPES } from '@campus/contracts';
import { notImplemented, type AiAnalyzer } from '@campus/domain';
import { audit as auditRepo, issues as issueRepo, outbox as outboxRepo, type Db } from '@campus/db';
import { actorOf, requireAuth } from '../auth-plugin.js';

export function registerIntegrationRoutes(
  app: FastifyInstance,
  deps: { db: Db; ai: AiAnalyzer; realtimeEnabled: boolean },
): void {
  const { db, ai } = deps;

  /* ---------------------------------------------------------------- */
  /* AI analysis routes moved to routes/analysis.ts (Phase 2)          */
  /* ---------------------------------------------------------------- */
  /**
   * The Phase 1 stub lived here and called the analyzer with empty strings — see
   * risk R1 in docs/PHASE2_AUDIT.md. Analysis now lives in routes/analysis.ts, where
   * the report is loaded, the caller authorized and the evidence resolved.
   */

  /* ---------------------------------------------------------------- */
  /* GET /v1/events/stream — real-time seam (Phase 2)                 */
  /* ---------------------------------------------------------------- */
  app.get('/v1/events/stream', { preHandler: requireAuth(db) }, async () => {
    // The durable half already exists: every state change writes to event_outbox in
    // the same transaction. What is missing is a delivery transport.
    throw notImplemented(
      'Live event streaming is not implemented in Phase 1. Events are already recorded ' +
        'durably in the transactional outbox; a WebSocket/SSE transport is Phase 2 work.',
    );
  });

  /* ---------------------------------------------------------------- */
  /* GET /v1/events/types — the declared event contract               */
  /* ---------------------------------------------------------------- */
  app.get('/v1/events/types', { preHandler: requireAuth(db) }, async () => ({
    eventTypes: EVENT_TYPES,
    deliveryMode: 'transactional-outbox',
    liveTransport: 'NOT_IMPLEMENTED',
    humanReviewConfidenceThreshold: AI_REVIEW_CONFIDENCE_THRESHOLD,
  }));

  /* ---------------------------------------------------------------- */
  /* GET /v1/admin/outbox — operational visibility for the team       */
  /* ---------------------------------------------------------------- */
  app.get(
    '/v1/admin/outbox',
    {
      preHandler: requireAuth(db, 'ADMIN'),
      schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    },
    async (request) => {
      const actor = actorOf(request);
      const { limit } = request.query as { limit: number };
      const rows = await outboxRepo.pending(db, actor.workspaceId, limit);
      return {
        pendingCount: rows.length,
        items: rows.map((row) => ({
          id: (row as Record<string, unknown>).id as string,
          eventType: (row as Record<string, unknown>).event_type as string,
          entityId: (row as Record<string, unknown>).entity_id as string,
          occurredAt: new Date((row as Record<string, unknown>).occurred_at as string).toISOString(),
        })),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /v1/admin/dashboard/summary — data for the Phase 3 website   */
  /* ---------------------------------------------------------------- */
  app.get('/v1/admin/dashboard/summary', { preHandler: requireAuth(db, 'HOD', 'ADMIN') }, async (request) => {
    const actor = actorOf(request);
    const counts = await issueRepo.statusCounts(db, actor.workspaceId);

    const overdue = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issues
        WHERE workspace_id = $1 AND status NOT IN ('RESOLVED','DUPLICATE') AND due_at < now()`,
      [actor.workspaceId],
    );

    const avgResolution = await db.query<{ hours: string | null }>(
      `SELECT avg(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600)::text AS hours
         FROM issues WHERE workspace_id = $1 AND status = 'RESOLVED' AND resolved_at IS NOT NULL`,
      [actor.workspaceId],
    );

    const byBlock = await db.query<{ block_id: string; official_name: string; n: string }>(
      `SELECT i.block_id, b.official_name, count(*)::text AS n
         FROM issues i JOIN campus_blocks b ON b.id = i.block_id
        WHERE i.workspace_id = $1 GROUP BY i.block_id, b.official_name ORDER BY count(*) DESC`,
      [actor.workspaceId],
    );

    const byCategory = await db.query<{ category_id: string; name: string; n: string }>(
      `SELECT i.category_id, c.name, count(*)::text AS n
         FROM issues i JOIN issue_categories c ON c.id = i.category_id
        WHERE i.workspace_id = $1 GROUP BY i.category_id, c.name ORDER BY count(*) DESC`,
      [actor.workspaceId],
    );

    return {
      scope: { workspace: actor.workspaceKind, generatedAt: new Date().toISOString() },
      counts: {
        submitted: counts.SUBMITTED ?? 0,
        approved: counts.APPROVED ?? 0,
        inProgress: counts.IN_PROGRESS ?? 0,
        resolved: counts.RESOLVED ?? 0,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
      },
      overdue: Number(overdue.rows[0]!.n),
      averageResolutionHours: avgResolution.rows[0]!.hours ? Number(avgResolution.rows[0]!.hours) : null,
      byBlock: byBlock.rows.map((r) => ({ blockId: r.block_id, blockName: r.official_name, count: Number(r.n) })),
      byCategory: byCategory.rows.map((r) => ({ categoryId: r.category_id, categoryName: r.name, count: Number(r.n) })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* GET /v1/admin/audit — sensitive action history                   */
  /* ---------------------------------------------------------------- */
  app.get(
    '/v1/admin/audit',
    {
      preHandler: requireAuth(db, 'ADMIN'),
      schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    },
    async (request) => {
      const actor = actorOf(request);
      const { limit } = request.query as { limit: number };
      const rows = await auditRepo.list(db, actor.workspaceId, limit);
      return { items: rows };
    },
  );
}
