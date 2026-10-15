/**
 * Test harness.
 *
 * Builds a COMPLETE, real application against an in-memory PGlite database (which is
 * genuine PostgreSQL 18.6, not an imitation) with migrations applied and reference
 * data seeded. No mocks of the database, no mocks of the domain logic, no network.
 *
 * That means the tests exercise the real SQL, the real constraints, the real state
 * machine and the real authorization — so a passing suite is actual evidence.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  AI_CONFIG_DEFAULTS,
  createPgliteDb,
  runMigrations,
  seedCampusReferenceData,
  type AppConfig,
  type Db,
} from '@campus/db';
import { LocalEvidenceStorage } from '@campus/domain';
import { buildApp } from '../apps/api/src/app.js';

export const TEST_PASSWORD = 'Demo#Passw0rd!2026';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  storage: LocalEvidenceStorage;
  evidenceDir: string;
  /** Tokens per role, obtained by really logging in through the HTTP layer. */
  tokens: { student: string; student2: string; hod: string; admin: string };
  /** Convenience ids for assertions. */
  ids: { demoWorkspaceId: string; realWorkspaceId: string; blockId: string; spotId: string; categoryId: string };
  /** The exact config the harness booted with, so tests can build variant apps. */
  config: AppConfig;
  cleanup: () => Promise<void>;
}

/** A real, valid 1x1 PNG — storage validates magic bytes, so a fake buffer would fail. */
export const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

export interface TestContextOptions extends Partial<AppConfig> {
  /**
   * Skip the harness's own logins. Needed by the rate-limiting test, which must not
   * consume the very login budget it is trying to measure.
   */
  skipLogin?: boolean;
}

export async function createTestContext(
  options: TestContextOptions = {},
): Promise<TestContext> {
  const { skipLogin = false, ...configOverrides } = options;
  const db = await createPgliteDb(); // in-memory: fresh, isolated DB per test file
  await runMigrations(db);
  await seedCampusReferenceData(db);

  const evidenceDir = await mkdtemp(path.join(tmpdir(), 'campus-evidence-'));

  const config: AppConfig = {
    databaseUrl: undefined,
    pgliteDir: undefined,
    port: 0,
    host: '127.0.0.1',
    nodeEnv: 'test',
    sessionTtlHours: 8,
    evidenceDir,
    maxEvidenceBytes: 8 * 1024 * 1024,
    logLevel: 'silent',
    // Raised so ordinary test traffic is never throttled; the dedicated
    // rate-limiting test lowers these deliberately.
    rateLimitMax: 100_000,
    loginRateLimitMax: 100_000,
    demoSeedPassword: TEST_PASSWORD,
    // AI stays unconfigured unless a test opts in, so the default suite never loads a
    // 149 MB model. Tests that exercise the provider inject a fake pipeline instead.
    ...AI_CONFIG_DEFAULTS,
    aiCacheDir: path.join(tmpdir(), 'campus-ai-cache'),
    ...configOverrides,
  };

  const storage = new LocalEvidenceStorage({ rootDir: evidenceDir, maxBytes: config.maxEvidenceBytes });
  const app = await buildApp({ db, config, storage });
  await app.ready();

  // Seed accounts through the REAL seeding path (argon2id hashing included).
  const { seedAccounts } = await import('@campus/db');
  await seedAccounts(db, { password: TEST_PASSWORD, includeRealAdmin: true });

  const login = async (email: string, password = TEST_PASSWORD): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    if (res.statusCode !== 200) {
      throw new Error(`Test login failed for ${email}: ${res.statusCode} ${res.body}`);
    }
    return res.json().accessToken as string;
  };

  const tokens = skipLogin
    ? { student: '', student2: '', hod: '', admin: '' }
    : {
        student: await login('student@demo.dsu.edu.in'),
        student2: await login('student2@demo.dsu.edu.in'),
        hod: await login('hod@demo.dsu.edu.in'),
        admin: await login('admin@demo.dsu.edu.in'),
      };

  const ws = await db.query<{ id: string; kind: string }>(`SELECT id, kind FROM workspaces`);
  const demoWorkspaceId = ws.rows.find((w) => w.kind === 'DEMO')!.id;
  const realWorkspaceId = ws.rows.find((w) => w.kind === 'REAL')!.id;

  const block = await db.query<{ id: string }>(
    `SELECT id FROM campus_blocks WHERE workspace_id = $1 ORDER BY official_name LIMIT 1`,
    [demoWorkspaceId],
  );
  const blockId = block.rows[0]!.id;
  const spot = await db.query<{ id: string }>(
    `SELECT id FROM campus_spots WHERE block_id = $1 ORDER BY official_name LIMIT 1`,
    [blockId],
  );
  const category = await db.query<{ id: string }>(`SELECT id FROM issue_categories ORDER BY name LIMIT 1`);

  return {
    app,
    db,
    storage,
    evidenceDir,
    tokens,
    ids: {
      demoWorkspaceId,
      realWorkspaceId,
      blockId,
      spotId: spot.rows[0]!.id,
      categoryId: category.rows[0]!.id,
    },
    config,
    cleanup: async () => {
      await app.close();
      await db.close();
      await rm(evidenceDir, { recursive: true, force: true });
    },
  };
}

/**
 * Builds a SECOND application instance over the SAME database, with different config.
 *
 * This exists because booting an extra PGlite engine per test is expensive: the
 * PostgreSQL WASM instance is memory-hungry, and several tests each creating their own
 * caused the vitest worker process to be OOM-killed (observed as files reporting
 * fewer tests with "Worker exited unexpectedly").
 *
 * Sharing the database is also more honest for tests like rate limiting: the behaviour
 * under test is the HTTP layer, not a fresh data store.
 */
export async function secondAppOverSharedDb(
  ctx: TestContext,
  configOverrides: Partial<AppConfig>,
): Promise<FastifyInstance> {
  const config: AppConfig = {
    databaseUrl: undefined,
    pgliteDir: undefined,
    port: 0,
    host: '127.0.0.1',
    nodeEnv: 'test',
    sessionTtlHours: 8,
    evidenceDir: ctx.evidenceDir,
    maxEvidenceBytes: 8 * 1024 * 1024,
    logLevel: 'silent',
    rateLimitMax: 100_000,
    loginRateLimitMax: 100_000,
    ...AI_CONFIG_DEFAULTS,
    aiCacheDir: path.join(tmpdir(), 'campus-ai-cache'),
    ...configOverrides,
  };
  const app = await buildApp({ db: ctx.db, config, storage: ctx.storage });
  await app.ready();
  return app;
}

/**
 * A database handle whose every operation fails, for exercising failure paths without
 * provisioning a real engine. Only the DB boundary is stubbed — the handler under test
 * is the real one.
 */
export function unreachableDb(): Db {
  const boom = () => {
    throw new Error('database unreachable (test stub)');
  };
  return {
    engine: 'postgres',
    query: async () => boom(),
    exec: async () => boom(),
    withTransaction: async () => boom(),
    close: async () => {},
  } as unknown as Db;
}

/* ------------------------------------------------------------------ */
/* Request helpers                                                     */
/* ------------------------------------------------------------------ */

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Builds a multipart/form-data payload without any third-party dependency.
 * Used to exercise the real upload path, including magic-byte validation.
 */
export function multipart(
  fields: Record<string, string>,
  file?: { fieldname?: string; filename?: string; contentType?: string; data: Buffer },
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----campustest${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }

  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldname ?? 'photo'}"; ` +
          `filename="${file.filename ?? 'capture.png'}"\r\nContent-Type: ${file.contentType ?? 'image/png'}\r\n\r\n`,
        'utf8',
      ),
    );
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** Submits a report as the given student and returns the parsed response. */
export async function submitReport(
  ctx: TestContext,
  token: string,
  overrides: Partial<{
    blockId: string;
    spotId: string;
    selectedCategoryId: string;
    title: string;
    description: string;
    latitude: number;
    longitude: number;
    capturedAt: string;
    photo: Buffer;
  }> = {},
) {
  const fields: Record<string, string> = {
    blockId: overrides.blockId ?? ctx.ids.blockId,
    spotId: overrides.spotId ?? ctx.ids.spotId,
    selectedCategoryId: overrides.selectedCategoryId ?? ctx.ids.categoryId,
    title: overrides.title ?? 'Water leaking from ceiling',
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
    ...(overrides.latitude !== undefined ? { latitude: String(overrides.latitude) } : {}),
    ...(overrides.longitude !== undefined ? { longitude: String(overrides.longitude) } : {}),
    ...(overrides.capturedAt !== undefined ? { capturedAt: overrides.capturedAt } : {}),
  };

  const body = multipart(fields, { data: overrides.photo ?? TINY_PNG });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/reports',
    headers: { ...auth(token), ...body.headers },
    payload: body.payload,
  });
  return { res, json: res.statusCode < 400 ? res.json() : null };
}

/**
 * Creates a NEW named spot so a test gets its own physical defect.
 *
 * This matters: the dedupe key is spot+category, so two tests sharing a spot would
 * (correctly!) be handed the SAME master issue. Test isolation here must mirror the
 * real-world semantics — a different location is a different defect.
 */
export async function createSpot(ctx: TestContext, label = `Test Spot ${randomUUID().slice(0, 8)}`) {
  const r = await ctx.db.query<{ id: string }>(
    `INSERT INTO campus_spots (workspace_id, block_id, official_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [ctx.ids.demoWorkspaceId, ctx.ids.blockId, label],
  );
  return { spotId: r.rows[0]!.id, blockId: ctx.ids.blockId };
}

/** Drives an issue through the full happy path and returns its id. */
export async function createIssueThroughWorkflow(ctx: TestContext, token = ctx.tokens.student): Promise<string> {
  // Fresh spot per call -> a genuinely new master issue, not a duplicate of an earlier test's.
  const { spotId } = await createSpot(ctx);
  const { json } = await submitReport(ctx, token, { spotId, title: 'Workflow test defect' });
  return json.issueId as string;
}

export const errorCode = (res: { json: () => unknown }): string => {
  const body = res.json() as { error?: { code?: string } };
  return body.error?.code ?? 'NO_CODE';
};

export const reasonOf = (res: { json: () => unknown }): string => {
  const body = res.json() as { error?: { message?: string } };
  return body.error?.message ?? '';
};
