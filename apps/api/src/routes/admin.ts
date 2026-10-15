/**
 * Administration: accounts, roles, campus locations and categories.
 *
 * Every route here is ADMIN-only. No route accepts a role or a workspace from the
 * client, and role changes are audited with before/after values.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RoleSchema } from '@campus/contracts';
import { assertRoleChangeIsAuthorized, forbidden, notFound } from '@campus/domain';
import { audit as auditRepo, users as userRepo, type Db } from '@campus/db';
import { actorOf, requireAuth } from '../auth-plugin.js';

const IdParams = z.object({ id: z.uuid() });
const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens only');

export function registerAdminRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  /* ------------------------------ users ------------------------------ */

  app.get(
    '/v1/admin/users',
    {
      preHandler: requireAuth(db, 'ADMIN'),
      schema: { querystring: z.object({ role: RoleSchema.optional() }) },
    },
    async (request) => {
      const actor = actorOf(request);
      const { role } = request.query as { role?: string };
      const rows = await userRepo.list(db, actor.workspaceId, role);
      return {
        items: rows.map((u) => ({
          id: u.id,
          email: u.normalized_email,
          displayName: u.display_name,
          role: u.role,
          accountStatus: u.account_status,
          department: u.department,
        })),
      };
    },
  );

  /**
   * Role change. Admin-only, audited, and NOT self-serve:
   *  - a user can never change their own role (no self-elevation)
   *  - the target must be in the actor's own workspace (no cross-workspace writes)
   */
  app.patch(
    '/v1/admin/users/:id/role',
    {
      preHandler: requireAuth(db, 'ADMIN'),
      schema: { params: IdParams, body: z.object({ role: RoleSchema }) },
    },
    async (request) => {
      const actor = actorOf(request);
      assertRoleChangeIsAuthorized(actor.role);

      const { id } = request.params as z.infer<typeof IdParams>;
      const { role } = request.body as { role: 'STUDENT' | 'HOD' | 'ADMIN' };

      if (id === actor.userId) {
        throw forbidden('You cannot change your own role. Ask another administrator.');
      }

      const before = await userRepo.findById(db, actor.workspaceId, id);
      if (!before) throw notFound('User not found in your workspace.');

      const after = await userRepo.updateRole(db, actor.workspaceId, id, role);
      if (!after) throw notFound('User not found in your workspace.');

      await auditRepo.record(db, {
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        action: 'user.role_changed',
        entityType: 'USER',
        entityId: id,
        before: { role: before.role },
        after: { role: after.role },
        reason: 'Administrative role change',
      });

      request.log.warn({ actorUserId: actor.userId, targetUserId: id, from: before.role, to: after.role }, 'role changed');
      return { user: { id: after.id, email: after.normalized_email, role: after.role } };
    },
  );

  app.patch(
    '/v1/admin/users/:id/status',
    {
      preHandler: requireAuth(db, 'ADMIN'),
      schema: { params: IdParams, body: z.object({ accountStatus: z.enum(['ACTIVE', 'SUSPENDED']) }) },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IdParams>;
      const { accountStatus } = request.body as { accountStatus: 'ACTIVE' | 'SUSPENDED' };
      if (id === actor.userId) throw forbidden('You cannot change your own account status.');

      const after = await userRepo.updateStatus(db, actor.workspaceId, id, accountStatus);
      if (!after) throw notFound('User not found in your workspace.');

      await auditRepo.record(db, {
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        action: 'user.status_changed',
        entityType: 'USER',
        entityId: id,
        after: { accountStatus },
      });
      return { user: { id: after.id, accountStatus: after.account_status } };
    },
  );

  /* ---------------------------- campus blocks --------------------------- */

  app.post(
    '/v1/admin/blocks',
    {
      preHandler: requireAuth(db, 'ADMIN'),
      schema: {
        body: z.object({
          officialName: z.string().trim().min(2).max(120),
          slug: SlugSchema,
          description: z.string().trim().max(500).optional(),
          latitude: z.number().gte(-90).lte(90).optional(),
          longitude: z.number().gte(-180).lte(180).optional(),
        }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const body = request.body as { officialName: string; slug: string; description?: string };

      const created = await db.query<{ id: string }>(
        `INSERT INTO campus_blocks (workspace_id, official_name, slug, description)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [actor.workspaceId, body.officialName, body.slug, body.description ?? null],
      );

      await auditRepo.record(db, {
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        action: 'campus_block.created',
        entityType: 'CAMPUS_BLOCK',
        entityId: created.rows[0]!.id,
        after: { officialName: body.officialName, slug: body.slug },
      });

      return { id: created.rows[0]!.id };
    },
  );

  app.patch(
    '/v1/admin/blocks/:id',
    {
      preHandler: requireAuth(db, 'ADMIN'),
      schema: {
        params: IdParams,
        body: z.object({
          officialName: z.string().trim().min(2).max(120).optional(),
          description: z.string().trim().max(500).nullable().optional(),
          active: z.boolean().optional(),
        }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IdParams>;
      const body = request.body as { officialName?: string; description?: string | null; active?: boolean };

      const updated = await db.query<{ id: string }>(
        `UPDATE campus_blocks
            SET official_name = COALESCE($3, official_name),
                description   = CASE WHEN $4::boolean THEN $5 ELSE description END,
                active        = COALESCE($6, active),
                updated_at    = now()
          WHERE id = $1 AND workspace_id = $2
          RETURNING id`,
        [
          id,
          actor.workspaceId,
          body.officialName ?? null,
          body.description !== undefined,
          body.description ?? null,
          body.active ?? null,
        ],
      );
      if (updated.rows.length === 0) throw notFound('Campus block not found in your workspace.');

      await auditRepo.record(db, {
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        action: 'campus_block.updated',
        entityType: 'CAMPUS_BLOCK',
        entityId: id,
        after: body,
      });
      return { id };
    },
  );

  /* ----------------------------- campus spots --------------------------- */

  app.post(
    '/v1/admin/spots',
    {
      preHandler: requireAuth(db, 'ADMIN'),
      schema: {
        body: z.object({
          blockId: z.uuid(),
          officialName: z.string().trim().min(2).max(160),
          buildingLabel: z.string().trim().max(80).optional(),
          floorLabel: z.string().trim().max(80).optional(),
          areaLabel: z.string().trim().max(80).optional(),
          latitude: z.number().gte(-90).lte(90).optional(),
          longitude: z.number().gte(-180).lte(180).optional(),
        }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const body = request.body as {
        blockId: string;
        officialName: string;
        buildingLabel?: string;
        floorLabel?: string;
        areaLabel?: string;
        latitude?: number;
        longitude?: number;
      };

      // Block must belong to the actor's workspace — prevents cross-workspace writes.
      const block = await db.query(`SELECT 1 FROM campus_blocks WHERE id = $1 AND workspace_id = $2`, [
        body.blockId,
        actor.workspaceId,
      ]);
      if (block.rows.length === 0) throw notFound('Campus block not found in your workspace.');

      const created = await db.query<{ id: string }>(
        `INSERT INTO campus_spots
           (workspace_id, block_id, official_name, building_label, floor_label, area_label, latitude, longitude)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          actor.workspaceId,
          body.blockId,
          body.officialName,
          body.buildingLabel ?? null,
          body.floorLabel ?? null,
          body.areaLabel ?? null,
          body.latitude ?? null,
          body.longitude ?? null,
        ],
      );
      return { id: created.rows[0]!.id };
    },
  );

  /* ------------------------------ categories ---------------------------- */

  app.post(
    '/v1/admin/categories',
    {
      preHandler: requireAuth(db, 'ADMIN'),
      schema: {
        body: z.object({
          name: z.string().trim().min(2).max(120),
          slug: SlugSchema,
          description: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (request) => {
      const body = request.body as { name: string; slug: string; description?: string };
      const created = await db.query<{ id: string }>(
        `INSERT INTO issue_categories (name, slug, description) VALUES ($1,$2,$3) RETURNING id`,
        [body.name, body.slug, body.description ?? null],
      );
      return { id: created.rows[0]!.id };
    },
  );
}
