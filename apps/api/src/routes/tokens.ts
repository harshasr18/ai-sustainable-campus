/**
 * Token balance, ledger history and authorized reversals.
 *
 * The balance is ALWAYS derived from the immutable ledger. There is no endpoint that
 * sets or increments a balance directly, and no endpoint that lets a student award
 * themselves tokens.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ReverseTokensRequestSchema } from '@campus/contracts';
import { forbidden, notFound, reverseTokens, validationFailed } from '@campus/domain';
import { reports as reportRepo, tokens as tokenRepo, type Db } from '@campus/db';
import { actorOf, requireAuth } from '../auth-plugin.js';

export function registerTokenRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  /* GET /v1/tokens/balance */
  app.get('/v1/tokens/balance', { preHandler: requireAuth(db) }, async (request) => {
    const actor = actorOf(request);
    const balance = await tokenRepo.balance(db, actor.workspaceId, actor.userId);
    return { userId: actor.userId, ...balance };
  });

  /* GET /v1/tokens/transactions */
  app.get(
    '/v1/tokens/transactions',
    {
      preHandler: requireAuth(db),
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(25),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = request.query as { limit: number; offset: number };
      const { items, total } = await tokenRepo.history(db, actor.workspaceId, actor.userId, q.limit, q.offset);
      return {
        items: items.map((row) => ({
          id: row.id,
          userId: row.user_id,
          reportId: row.report_id,
          transactionType: row.transaction_type,
          amount: row.amount,
          idempotencyKey: row.idempotency_key,
          reason: row.reason,
          createdByUserId: row.created_by_user_id,
          createdAt: new Date(row.created_at).toISOString(),
        })),
        total,
        limit: q.limit,
        offset: q.offset,
      };
    },
  );

  /* POST /v1/tokens/reverse — staff-only, reason mandatory, fully audited */
  app.post(
    '/v1/tokens/reverse',
    { preHandler: requireAuth(db, 'HOD', 'ADMIN'), schema: { body: ReverseTokensRequestSchema } },
    async (request) => {
      const actor = actorOf(request);
      const body = request.body as z.infer<typeof ReverseTokensRequestSchema>;

      if (!body.reportId) {
        throw validationFailed('reportId is required to reverse a token award.');
      }

      const report = await reportRepo.findById(db, actor.workspaceId, body.reportId);
      if (!report) throw notFound('Report not found in your campus.');
      if (report.reporter_user_id === actor.userId) {
        // Separation of duties: an HOD cannot reverse their own award.
        throw forbidden('You cannot reverse a token award for your own report.');
      }

      const credit = await tokenRepo.latestCreditForReport(db, actor.workspaceId, body.reportId);
      const amount = body.amount ?? credit?.amount ?? 10;

      const result = await reverseTokens(db, {
        workspaceId: actor.workspaceId,
        userId: report.reporter_user_id,
        reportId: body.reportId,
        amount,
        reason: body.reason,
        actorUserId: actor.userId,
        actorRole: actor.role,
      });

      request.log.warn(
        { actorUserId: actor.userId, reportId: body.reportId, amount, reversed: result.inserted },
        'token award reversed',
      );

      return { reversed: true, amount, alreadyReversed: !result.inserted, transactionId: result.transactionId };
    },
  );
}
