/**
 * Phase 1 acceptance criterion #17 — concurrent duplicate submissions.
 *
 * Two layers of testing, and the difference matters:
 *
 *  1. HTTP layer (always runs, on PGlite): N simultaneous submissions hitting the real
 *     API. On PGlite the engine serialises statements, so this proves the ON CONFLICT
 *     path is correct and that every request sees committed state — but it is NOT a
 *     true parallel race.
 *
 *  2. DATABASE layer (runs when TEST_DATABASE_URL is set): N genuinely parallel
 *     transactions on native PostgreSQL, each holding its OWN connection, forced into
 *     the worst-case interleaving by a barrier so that ALL of them read before ANY of
 *     them writes. This is the case that breaks naive implementations — Stage 1
 *     measured 10 concurrent transactions creating 10 master tickets for one defect.
 *
 * Run both with:
 *   TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/campus_test npm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createSpot, createTestContext, submitReport, type TestContext } from './helpers.js';
import { createPgDb, runMigrations, seedAccounts, seedCampusReferenceData } from '@campus/db';

const PARALLEL_SUBMISSIONS = 8;
const PG_URL = process.env.TEST_DATABASE_URL;
const describePg = PG_URL ? describe : describe.skip;

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.cleanup();
});

describe('HTTP layer — simultaneous submissions', () => {
  it(`creates exactly ONE master ticket from ${PARALLEL_SUBMISSIONS} concurrent identical reports`, async () => {
    const { spotId: spot } = await createSpot(ctx, 'Concurrent defect spot');

    const results = await Promise.all(
      Array.from({ length: PARALLEL_SUBMISSIONS }, (_, i) =>
        submitReport(ctx, i % 2 === 0 ? ctx.tokens.student : ctx.tokens.student2, {
          spotId: spot,
          title: 'Simultaneous leak reports',
        }),
      ),
    );

    // Every request must succeed — no user is told "duplicate request" as an error.
    for (const r of results) expect(r.res.statusCode).toBe(200);

    const issueIds = new Set(results.map((r) => r.json.issueId as string));
    expect(issueIds.size).toBe(1);

    // Exactly one request created the ticket; the rest linked to it.
    const created = results.filter((r) => r.json.duplicateOfExistingIssue === false).length;
    expect(created).toBe(1);

    const linked = results.filter((r) => r.json.duplicateOfExistingIssue === true && r.json.duplicateMatchStatus === 'LINKED').length;
    expect(linked).toBe(PARALLEL_SUBMISSIONS - 1);

    // And the database agrees.
    const issues = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issues WHERE workspace_id = $1 AND spot_id = $2`,
      [ctx.ids.demoWorkspaceId, spot],
    );
    expect(issues.rows[0]!.n).toBe('1');

    const linkedReports = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reports WHERE issue_id = (SELECT id FROM issues WHERE id = $1)`,
      [[...issueIds][0]],
    );
    expect(Number(linkedReports.rows[0]!.n)).toBeGreaterThanOrEqual(PARALLEL_SUBMISSIONS);
  });

  it('never awards tokens for concurrent submissions without validation', async () => {
    const { spotId: spot } = await createSpot(ctx, 'Concurrent token spot');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => submitReport(ctx, ctx.tokens.student, { spotId: spot, title: 'Concurrent token check' })),
    );
    const reportIds = results.map((r) => r.json.reportId as string);

    const ledger = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM token_transactions WHERE report_id = ANY($1::uuid[]) AND transaction_type = 'CREDIT'`,
      [reportIds],
    );
    expect(ledger.rows[0]!.n).toBe('0');
  });
});

describePg('DATABASE layer — true parallel race against native PostgreSQL', () => {
  it('creates ONE master ticket when N transactions race, all reading before any writes', async () => {
    const { Pool } = await import('pg');
    const db = await createPgDb({ connectionString: PG_URL! });

    // Fresh schema for a deterministic run. TEST_DATABASE_URL must point at a
    // DEDICATED, throwaway database — everything in `public` is dropped.
    await db.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await runMigrations(db);
    // The race inserts real rows with real foreign keys, so reference data and at
    // least one user must exist. This mirrors production schema usage exactly.
    await seedCampusReferenceData(db);
    await seedAccounts(db, { password: 'Concurrency#Test1', includeRealAdmin: false });

    const ws = await db.query<{ id: string }>(`SELECT id FROM workspaces WHERE kind = 'DEMO'`);
    const workspaceId = ws.rows[0]!.id;

    const pool = new Pool({ connectionString: PG_URL!, max: PARALLEL_SUBMISSIONS + 2 });

    // Prove the connections are genuinely separate backends, not a shared client.
    const pids = await Promise.all(
      Array.from({ length: PARALLEL_SUBMISSIONS }, async () => (await pool.query('SELECT pg_backend_pid() AS p')).rows[0].p),
    );
    expect(new Set(pids).size).toBeGreaterThan(1);

    const clients = await Promise.all(Array.from({ length: PARALLEL_SUBMISSIONS }, () => pool.connect()));
    const dedupeKey = 'race-test-key';
    const observedCounts: number[] = [];

    try {
      // PHASE A — every transaction reads the table BEFORE anyone inserts.
      // This is the interleaving that defeats application-level duplicate checks.
      await Promise.all(
        clients.map(async (client) => {
          await client.query('BEGIN');
          const r = await client.query(`SELECT count(*)::int AS n FROM issues WHERE workspace_id = $1 AND dedupe_key = $2`, [
            workspaceId,
            dedupeKey,
          ]);
          observedCounts.push(r.rows[0].n);
        }),
      );

      // All of them concurrently concluded "no duplicate exists".
      expect(observedCounts.every((n) => n === 0)).toBe(true);

      // PHASE B — everyone now tries to create the master ticket.
      const outcomes = await Promise.all(
        clients.map(async (client, i) => {
          const res = await client.query(
            `INSERT INTO issues (workspace_id, public_reference, title, category_id, block_id, spot_id,
                                 created_by_user_id, due_at, dedupe_key)
             SELECT $1, 'RACE-' || $2, 'Race issue', c.id, b.id, s.id, u.id, now() + interval '72 hours', $3
               FROM issue_categories c
               JOIN campus_blocks b ON b.workspace_id = $1
               JOIN campus_spots  s ON s.block_id = b.id
               JOIN users         u ON u.workspace_id = $1
             ON CONFLICT (workspace_id, dedupe_key) WHERE status <> 'RESOLVED' DO NOTHING
             RETURNING id`,
            [workspaceId, i, dedupeKey],
          );
          await client.query('COMMIT');
          return res.rows.length === 1 ? 'created' : 'linked';
        }),
      );

      const created = outcomes.filter((o) => o === 'created').length;
      const linked = outcomes.filter((o) => o === 'linked').length;

      // THE ASSERTION THAT MATTERS: one real-world defect, one repair ticket.
      expect(created).toBe(1);
      expect(linked).toBe(PARALLEL_SUBMISSIONS - 1);

      const finalCount = await pool.query(`SELECT count(*)::int AS n FROM issues WHERE dedupe_key = $1`, [dedupeKey]);
      expect(finalCount.rows[0].n).toBe(1);
    } finally {
      clients.forEach((c) => c.release());
      await pool.end();
      await db.close();
    }
  });

  it('awards the same report only once across N concurrent retries', async () => {
    const { Pool } = await import('pg');
    // Reuses the schema seeded by the previous test; re-seed defensively if it ran alone.
    const db = await createPgDb({ connectionString: PG_URL! });
    const pool = new Pool({ connectionString: PG_URL!, max: 8 });

    let user = await pool.query<{ id: string; workspace_id: string }>(`SELECT id, workspace_id FROM users LIMIT 1`);
    if (user.rows.length === 0) {
      await seedAccounts(db, { password: 'Concurrency#Test1', includeRealAdmin: false });
      user = await pool.query<{ id: string; workspace_id: string }>(`SELECT id, workspace_id FROM users LIMIT 1`);
    }
    const { id: userId, workspace_id: workspaceId } = user.rows[0]!;
    const key = 'concurrent-retry-key';

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const r = await pool.query(
          `INSERT INTO token_transactions (workspace_id, user_id, transaction_type, amount, idempotency_key)
           VALUES ($1,$2,'CREDIT',10,$3)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [workspaceId, userId, key],
        );
        return r.rows.length === 1 ? 'credited' : 'deduped';
      }),
    );

    expect(outcomes.filter((o) => o === 'credited'), JSON.stringify(outcomes)).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'deduped')).toHaveLength(7);

    const balance = await pool.query(
      `SELECT COALESCE(sum(amount),0)::int AS b FROM token_transactions WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, key],
    );
    expect(balance.rows[0].b).toBe(10);

    await pool.end();
    await db.close();
  });
});
