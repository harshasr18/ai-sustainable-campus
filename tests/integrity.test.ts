/**
 * Phase 1 acceptance criteria #10, #14, #15, #16 — referential integrity, workspace
 * isolation, private photo authorization, and honest failure reporting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AI_CONFIG_DEFAULTS } from '@campus/db';
import {
  auth,
  createTestContext,
  errorCode,
  multipart,
  secondAppOverSharedDb,
  submitReport,
  TINY_PNG,
  unreachableDb,
  type TestContext,
} from './helpers.js';
import { buildApp } from '../apps/api/src/app.js';

let ctx: TestContext;
let realAdminToken: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'admin@dsu.edu.in', password: 'Demo#Passw0rd!2026' },
  });
  realAdminToken = login.json().accessToken as string;
});
afterAll(async () => {
  await ctx.cleanup();
});

describe('Criterion 10 — a report cannot reference a nonexistent block or spot', () => {
  it('rejects a nonexistent spot', async () => {
    const res = await submitReport(ctx, ctx.tokens.student, { spotId: randomUUID() });
    expect(res.res.statusCode).toBe(400);
    expect(errorCode(res.res)).toBe('VALIDATION_FAILED');
  });

  it('rejects a spot that belongs to a DIFFERENT block', async () => {
    // Find a spot in another block of the same workspace.
    const other = await ctx.db.query<{ id: string; block_id: string }>(
      `SELECT id, block_id FROM campus_spots WHERE workspace_id = $1 AND block_id <> $2 LIMIT 1`,
      [ctx.ids.demoWorkspaceId, ctx.ids.blockId],
    );
    const res = await submitReport(ctx, ctx.tokens.student, {
      spotId: other.rows[0]!.id,
      // deliberately wrong block for this spot
      blockId: ctx.ids.blockId,
    });
    expect(res.res.statusCode).toBe(400);
    expect(res.res.json().error.message).toContain('does not belong');
  });

  it('rejects a nonexistent category', async () => {
    const res = await submitReport(ctx, ctx.tokens.student, { selectedCategoryId: randomUUID() });
    expect(res.res.statusCode).toBe(400);
  });

  it('rejects an inactive spot', async () => {
    await ctx.db.query(`UPDATE campus_spots SET active = false WHERE id = $1`, [ctx.ids.spotId]);
    const res = await submitReport(ctx, ctx.tokens.student);
    expect(res.res.statusCode).toBe(400);
    await ctx.db.query(`UPDATE campus_spots SET active = true WHERE id = $1`, [ctx.ids.spotId]);
  });

  it('leaves no report row behind after a rejected submission', async () => {
    const before = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM reports`);
    await submitReport(ctx, ctx.tokens.student, { spotId: randomUUID() });
    const after = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM reports`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe('Evidence upload validation', () => {
  it('rejects a non-image payload even when it claims to be a JPEG', async () => {
    const body = multipart(
      {
        blockId: ctx.ids.blockId,
        spotId: ctx.ids.spotId,
        selectedCategoryId: ctx.ids.categoryId,
        title: 'Fake photo attempt',
      },
      { data: Buffer.from('<html><script>alert(1)</script></html>'), contentType: 'image/jpeg', filename: 'evil.jpg' },
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: { ...auth(ctx.tokens.student), ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/Unsupported file type|does not match/i);
  });

  it('requires a photograph — a fields-only submission is refused', async () => {
    const body = multipart({
      blockId: ctx.ids.blockId,
      spotId: ctx.ids.spotId,
      selectedCategoryId: ctx.ids.categoryId,
      title: 'No photo attached',
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: { ...auth(ctx.tokens.student), ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/photograph is required/i);
  });

  it('rejects a JSON body outright (photos must use multipart)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: auth(ctx.tokens.student),
      payload: { blockId: ctx.ids.blockId, spotId: ctx.ids.spotId, selectedCategoryId: ctx.ids.categoryId, title: 'JSON attempt' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/multipart/i);
  });

  it('stores evidence under a generated key, never the client filename', async () => {
    const body = multipart(
      {
        blockId: ctx.ids.blockId,
        spotId: ctx.ids.spotId,
        selectedCategoryId: ctx.ids.categoryId,
        title: 'Path traversal attempt',
      },
      { data: TINY_PNG, filename: '../../../../etc/passwd.png' },
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: { ...auth(ctx.tokens.student), ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(200);

    const row = await ctx.db.query<{ evidence_storage_key: string }>(
      `SELECT evidence_storage_key FROM reports WHERE id = $1`,
      [res.json().reportId],
    );
    const key = row.rows[0]!.evidence_storage_key;
    expect(key).not.toContain('..');
    expect(key).not.toContain('passwd');
    expect(key).not.toContain('etc');
    // Namespaced by workspace + date + a random UUID.
    expect(key).toMatch(new RegExp(`^${ctx.ids.demoWorkspaceId}/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.png$`));
  });
});

describe('Criterion 15 — a user cannot retrieve another user\'s private photo', () => {
  it('allows the reporter, denies another student, allows HOD', async () => {
    const { json } = await submitReport(ctx, ctx.tokens.student);

    const owner = await ctx.app.inject({
      method: 'GET',
      url: `/v1/reports/${json.reportId}/evidence`,
      headers: auth(ctx.tokens.student),
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.headers['cache-control']).toContain('no-store');
    expect(owner.rawPayload.length).toBeGreaterThan(0);

    const otherStudent = await ctx.app.inject({
      method: 'GET',
      url: `/v1/reports/${json.reportId}/evidence`,
      headers: auth(ctx.tokens.student2),
    });
    expect(otherStudent.statusCode).toBe(403);

    const hod = await ctx.app.inject({
      method: 'GET',
      url: `/v1/reports/${json.reportId}/evidence`,
      headers: auth(ctx.tokens.hod),
    });
    expect(hod.statusCode).toBe(200);
  });

  it('denies an unauthenticated request for evidence', async () => {
    const { json } = await submitReport(ctx, ctx.tokens.student);
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/reports/${json.reportId}/evidence` });
    expect(res.statusCode).toBe(401);
  });

  it('denies reading another student\'s report metadata', async () => {
    const { json } = await submitReport(ctx, ctx.tokens.student);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/reports/${json.reportId}`,
      headers: auth(ctx.tokens.student2),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Criterion 14 — demo and real data cannot leak across workspaces', () => {
  it('gives the REAL workspace a completely separate issue view', async () => {
    // Create a real-workspace issue by promoting the real admin path: nothing exists
    // in REAL yet, and the demo issues created above must NOT be visible.
    await submitReport(ctx, ctx.tokens.student); // demo issue

    const demoQueue = await ctx.app.inject({ method: 'GET', url: '/v1/issues', headers: auth(ctx.tokens.hod) });
    expect(demoQueue.json().total).toBeGreaterThan(0);

    const realQueue = await ctx.app.inject({ method: 'GET', url: '/v1/issues', headers: auth(realAdminToken) });
    expect(realQueue.statusCode).toBe(200);
    expect(realQueue.json().total).toBe(0);
    expect(realQueue.json().items).toEqual([]);
  });

  it('keeps reference data scoped per workspace', async () => {
    const demoBlocks = await ctx.app.inject({ method: 'GET', url: '/v1/campus/blocks', headers: auth(ctx.tokens.student) });
    const realBlocks = await ctx.app.inject({ method: 'GET', url: '/v1/campus/blocks', headers: auth(realAdminToken) });

    const demoIds = demoBlocks.json().items.map((b: { id: string }) => b.id);
    const realIds = realBlocks.json().items.map((b: { id: string }) => b.id);

    expect(demoIds.length).toBeGreaterThan(0);
    expect(realIds.length).toBeGreaterThan(0);
    // Same logical campus, different physical rows — no shared ids across workspaces.
    expect(demoIds.some((id: string) => realIds.includes(id))).toBe(false);
  });

  it('refuses a DEMO session attempting to submit a report at a REAL-workspace spot', async () => {
    const realSpot = await ctx.db.query<{ id: string; block_id: string }>(
      `SELECT id, block_id FROM campus_spots WHERE workspace_id = $1 LIMIT 1`,
      [ctx.ids.realWorkspaceId],
    );

    const res = await submitReport(ctx, ctx.tokens.student, {
      spotId: realSpot.rows[0]!.id,
      blockId: realSpot.rows[0]!.block_id,
    });

    // The demo student's session is scoped to DEMO, so the REAL spot is invisible to it.
    expect(res.res.statusCode).toBe(400);
    expect(res.res.json().error.message).toContain('does not exist in your campus');
  });

  it('scopes the token ledger per workspace', async () => {
    const demoStudents = await ctx.db.query<{ id: string }>(
      `SELECT id FROM users WHERE normalized_email = 'student@demo.dsu.edu.in'`,
    );
    const rows = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM token_transactions WHERE user_id = $1 AND workspace_id <> $2`,
      [demoStudents.rows[0]!.id, ctx.ids.demoWorkspaceId],
    );
    expect(rows.rows[0]!.n).toBe('0');
  });

  it('scopes the outbox events per workspace', async () => {
    const rows = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event_outbox e
        JOIN issues i ON i.id = e.entity_id
       WHERE e.workspace_id <> i.workspace_id`,
    );
    expect(rows.rows[0]!.n).toBe('0');
  });
});

describe('Criterion 16 — failed writes never produce false success', () => {
  it('rolls back a transaction that throws, leaving no partial state', async () => {
    const before = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM issues`);

    // Resolve everything BEFORE opening the transaction: PGlite is single-connection,
    // so querying the outer handle from inside a transaction would deadlock.
    const reporterId = (
      await ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE normalized_email='student@demo.dsu.edu.in'`)
    ).rows[0]!.id;

    await expect(
      ctx.db.withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO issues (workspace_id, public_reference, title, category_id, block_id, spot_id,
                               created_by_user_id, due_at, dedupe_key)
           VALUES ($1,'ROLLBACK-TEST','Should not persist',$2,$3,$4,$5, now() + interval '72 hours','rollback-test')`,
          [ctx.ids.demoWorkspaceId, ctx.ids.categoryId, ctx.ids.blockId, ctx.ids.spotId, reporterId],
        );
        throw new Error('simulated downstream failure');
      }),
    ).rejects.toThrow('simulated downstream failure');

    const after = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM issues`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

    const leaked = await ctx.db.query(`SELECT 1 FROM issues WHERE public_reference = 'ROLLBACK-TEST'`);
    expect(leaked.rows).toHaveLength(0);
  });

  it('does not create an issue when the report insert fails', async () => {
    const before = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM issues`);
    // Invalid category id (valid UUID, no such row) -> FK violation inside the same
    // transaction that would have created the issue.
    await submitReport(ctx, ctx.tokens.student, { selectedCategoryId: randomUUID() });
    const after = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM issues`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('reports a degraded health status instead of a false OK', async () => {
    // Only the DATABASE BOUNDARY is stubbed as unreachable; the health handler itself
    // is the real one. This exercises the failure branch without booting a second
    // PostgreSQL engine (which previously OOM-killed the worker).
    const app = await buildApp({
      db: unreachableDb(),
      config: {
        databaseUrl: undefined,
        pgliteDir: undefined,
        port: 0,
        host: '127.0.0.1',
        nodeEnv: 'test',
        sessionTtlHours: 8,
        evidenceDir: ctx.evidenceDir,
        maxEvidenceBytes: 1024 * 1024,
        logLevel: 'silent',
        rateLimitMax: 100_000,
        loginRateLimitMax: 100_000,
        ...AI_CONFIG_DEFAULTS,
        aiCacheDir: path.join(tmpdir(), 'campus-ai-cache'),
      },
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('degraded');
      expect(res.json().database.ok).toBe(false);
      expect(res.json().database.error).toContain('unreachable');
    } finally {
      await app.close();
    }
  });

  it('never leaks a stack trace or internal detail to the client', async () => {
    const res = await submitReport(ctx, ctx.tokens.student, { spotId: randomUUID() });
    const body = JSON.stringify(res.res.json());
    expect(body).not.toMatch(/at .*\.ts:\d+/);
    expect(body).not.toMatch(/node_modules/);
    expect(body).not.toMatch(/ck_reports|23503|SQLSTATE/);
    expect(Object.keys(res.res.json())).toEqual(['error']);
  });
});
