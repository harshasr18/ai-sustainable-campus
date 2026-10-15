/**
 * Campus reference data. Every query is scoped to the caller's SESSION workspace,
 * so a demo account can only ever see demo campus reference data.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { campus as campusRepo, type Db } from '@campus/db';
import { actorOf, requireAuth } from '../auth-plugin.js';

const BlockParamsSchema = z.object({ blockId: z.uuid() });

export function registerCampusRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  app.get('/v1/campus/blocks', { preHandler: requireAuth(db) }, async (request) => {
    const actor = actorOf(request);
    const rows = await campusRepo.listBlocks(db, actor.workspaceId);
    return {
      items: rows.map((row) => ({
        id: row.id,
        officialName: row.official_name,
        slug: row.slug,
        description: row.description,
        active: row.active,
      })),
    };
  });

  app.get(
    '/v1/campus/blocks/:blockId/spots',
    { preHandler: requireAuth(db), schema: { params: BlockParamsSchema } },
    async (request) => {
      const actor = actorOf(request);
      const { blockId } = request.params as z.infer<typeof BlockParamsSchema>;
      const rows = await campusRepo.listSpots(db, actor.workspaceId, blockId);
      return {
        items: rows.map((row) => ({
          id: row.id,
          blockId: row.block_id,
          officialName: row.official_name,
          buildingLabel: row.building_label,
          floorLabel: row.floor_label,
          latitude: row.latitude,
          longitude: row.longitude,
          active: row.active,
        })),
      };
    },
  );

  // Categories are global (not workspace-scoped) configuration data.
  app.get('/v1/campus/categories', { preHandler: requireAuth(db) }, async () => {
    const rows = await campusRepo.listCategories(db);
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        active: row.active,
      })),
    };
  });
}
