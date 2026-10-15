/**
 * Authentication routes.
 *
 * Security properties (all verified by automated tests in tests/auth.test.ts):
 *  - identical error for unknown email / wrong password / suspended account
 *  - argon2id hashing; raw session token is never persisted
 *  - client-supplied `role` is IGNORED — registration always creates a STUDENT
 *  - logout revokes the session immediately (the very next request fails)
 *  - auth endpoints are rate limited
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  LoginRequestSchema,
  RegisterRequestSchema,
  SessionUserSchema,
  type Role,
} from '@campus/contracts';
import {
  authenticatePassword,
  forbidden,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  validationFailed,
} from '@campus/domain';
import { sessions as sessionRepo, users as userRepo, type AppConfig, type Db } from '@campus/db';
import { actorOf, requireAuth } from '../auth-plugin.js';

export function registerAuthRoutes(app: FastifyInstance, deps: { db: Db; config: AppConfig }): void {
  const { db, config } = deps;

  /* ---------------------------------------------------------------- */
  /* POST /v1/auth/login                                              */
  /* ---------------------------------------------------------------- */
  app.post(
    '/v1/auth/login',
    {
      config: {
        // Login throttling (brief Section 10). Default 10 attempts/minute/IP.
        rateLimit: { max: config.loginRateLimitMax, timeWindow: '1 minute' },
      },
      schema: { body: LoginRequestSchema },
    },
    async (request) => {
      // Email is already trimmed + lowercased by the contract schema BEFORE
      // validation — this is what makes "Student@DSU.edu.in " work correctly.
      const { email, password } = request.body as z.infer<typeof LoginRequestSchema>;

      const user = await userRepo.findByEmail(db, email);

      // Always performs comparable hash work, even for unknown accounts, so response
      // timing does not reveal which university emails are registered.
      await authenticatePassword(
        { passwordHash: user?.password_hash ?? null, accountStatus: (user?.account_status ?? 'ACTIVE') as 'ACTIVE' | 'SUSPENDED' },
        password,
      );

      // authenticatePassword throws for every failure mode, so `user` is non-null here.
      const found = user!;
      const token = generateSessionToken();
      const session = await sessionRepo.create(db, {
        userId: found.id,
        tokenHash: hashSessionToken(token),
        ttlHours: config.sessionTtlHours,
        userAgent: request.headers['user-agent'] ?? null,
      });

      request.log.info({ userId: found.id, role: found.role }, 'login succeeded');

      return {
        accessToken: token,
        expiresAt: new Date(session.expires_at).toISOString(),
        user: SessionUserSchema.parse({
          id: found.id,
          email: found.normalized_email,
          displayName: found.display_name,
          role: found.role as Role,
          accountStatus: found.account_status,
          workspace: found.workspace_kind,
        }),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /v1/auth/logout                                             */
  /* ---------------------------------------------------------------- */
  app.post('/v1/auth/logout', { preHandler: requireAuth(db) }, async (request) => {
    const actor = actorOf(request);
    const token = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const revoked = await sessionRepo.revoke(db, hashSessionToken(token));
    request.log.info({ userId: actor.userId, revoked }, 'logout');
    return { loggedOut: true, sessionRevoked: revoked };
  });

  /* ---------------------------------------------------------------- */
  /* GET /v1/auth/me                                                  */
  /* ---------------------------------------------------------------- */
  app.get('/v1/auth/me', { preHandler: requireAuth(db) }, async (request) => {
    const actor = actorOf(request);
    const user = await userRepo.findById(db, actor.workspaceId, actor.userId);
    if (!user) throw forbidden('Account is no longer available.');
    return {
      user: SessionUserSchema.parse({
        id: user.id,
        email: user.normalized_email,
        displayName: user.display_name,
        role: user.role,
        accountStatus: user.account_status,
        workspace: actor.workspaceKind,
      }),
    };
  });

  /* ---------------------------------------------------------------- */
  /* POST /v1/auth/register — DEVELOPMENT ONLY                        */
  /* ---------------------------------------------------------------- */
  app.post(
    '/v1/auth/register',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
      schema: { body: RegisterRequestSchema },
    },
    async (request) => {
      if (config.nodeEnv === 'production') {
        // Production accounts are provisioned by an admin, not by public signup.
        throw forbidden('Self-registration is disabled. Contact the campus administrator for an account.');
      }

      const { email, password, displayName } = request.body as z.infer<typeof RegisterRequestSchema>;

      // The REAL workspace is the only sane default for a non-demo account.
      const real = await db.query<{ id: string }>(`SELECT id FROM workspaces WHERE kind = 'REAL'`);
      const workspaceId = real.rows[0]?.id;
      if (!workspaceId) throw validationFailed('Campus workspaces are not initialised. Run migrations and seeding first.');

      const passwordHash = await hashPassword(password);

      try {
        const created = await userRepo.create(db, {
          workspaceId,
          email,
          displayName,
          passwordHash,
          // HARDCODED BY DESIGN: role is server-assigned. Any `role` field a client
          // sends is not read anywhere in this codebase.
          role: 'STUDENT',
        });
        return { user: { id: created.id, email: created.normalized_email, role: created.role } };
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          // Do not confirm whether the address was already registered.
          throw validationFailed('That account could not be created. Try signing in instead.');
        }
        throw err;
      }
    },
  );
}
