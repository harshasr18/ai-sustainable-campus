/**
 * Duplicate suggestions — HOD/ADMIN review of uncertain matches (Phase 5, migration 0010).
 *
 * Suggestions are produced by the server rule in packages/domain/src/duplicates.ts during
 * analysis. These routes only let staff read and decide them; nothing here creates one.
 * Authorization is server-side on every route: a student cannot list, confirm or dismiss.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  confirmDuplicateSuggestion,
  dismissDuplicateSuggestion,
  listOpenSuggestions,
  listSuggestionsForIssue,
  notFound,
  validationFailed,
} from '@campus/domain';
import { issues as issueRepo, type Db } from '@campus/db';
import { actorOf, requireAuth } from '../auth-plugin.js';

const IdParams = z.object({ id: z.uuid() });
/** Parsed in the handler (after auth), so an unauthorised caller gets 403, not a 400. */
const DecisionBody = z.object({ note: z.string().trim().max(500).optional() }).nullish();

function parseDecision(body: unknown): { note: string | null } {
  const parsed = DecisionBody.safeParse(body);
  if (!parsed.success) throw validationFailed('note must be text of at most 500 characters.');
  return { note: parsed.data?.note ?? null };
}

export function registerDuplicateRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  app.get(
    '/v1/duplicate-suggestions',
    {
      preHandler: requireAuth(db, 'HOD', 'ADMIN'),
      schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }) },
    },
    async (request) => {
      const actor = actorOf(request);
      const { limit } = request.query as { limit: number };
      const items = await listOpenSuggestions(db, actor.workspaceId, limit);
      return { count: items.length, items };
    },
  );

  app.get(
    '/v1/issues/:id/duplicate-suggestions',
    { preHandler: requireAuth(db, 'HOD', 'ADMIN'), schema: { params: IdParams } },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IdParams>;
      const issue = await issueRepo.findById(db, actor.workspaceId, id);
      if (!issue) throw notFound('Issue not found.');
      return { items: await listSuggestionsForIssue(db, actor.workspaceId, id) };
    },
  );

  app.post(
    '/v1/duplicate-suggestions/:id/confirm',
    { preHandler: requireAuth(db, 'HOD', 'ADMIN'), schema: { params: IdParams } },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IdParams>;
      return confirmDuplicateSuggestion(db, actor, { suggestionId: id, ...parseDecision(request.body) });
    },
  );

  app.post(
    '/v1/duplicate-suggestions/:id/dismiss',
    { preHandler: requireAuth(db, 'HOD', 'ADMIN'), schema: { params: IdParams } },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IdParams>;
      return dismissDuplicateSuggestion(db, actor, { suggestionId: id, ...parseDecision(request.body) });
    },
  );
}
