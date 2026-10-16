/**
 * PGlite driver — concurrent use (Phase 5 regression test, no mocks).
 *
 * The driver used to throw for ANY query issued while another request held a transaction,
 * so overlapping HTTP requests in PGlite mode (the default for local/Windows runs) could
 * fail at random with a 500. It must now queue them, while still refusing the one genuine
 * misuse: the OUTER handle used inside a transaction's own callback, which would deadlock.
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from './helpers.js';

describe('PGlite driver under concurrency', () => {
  it('queues overlapping transactions and outside queries instead of failing them', async () => {
    const ctx = await createTestContext();
    try {
      await ctx.db.query(`CREATE TEMP TABLE IF NOT EXISTS t_conc (n int)`);
      const slowTx = (n: number) =>
        ctx.db.withTransaction(async (tx) => {
          await tx.query(`INSERT INTO t_conc VALUES ($1)`, [n]);
          await new Promise((r) => setTimeout(r, 20));
          await tx.query(`INSERT INTO t_conc VALUES ($1)`, [n]);
        });
      const results = await Promise.allSettled([
        slowTx(1),
        ctx.db.query(`SELECT 1`),
        slowTx(2),
        ctx.db.query(`SELECT count(*) FROM t_conc`),
        slowTx(3),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
      const rows = await ctx.db.query<{ n: number }>(`SELECT n FROM t_conc ORDER BY n`);
      // Each transaction's two rows are contiguous: no interleaving inside a transaction.
      expect(rows.rows.map((r) => r.n)).toEqual([1, 1, 2, 2, 3, 3]);
    } finally {
      await ctx.cleanup();
    }
  });

  it('still refuses the outer handle inside a transaction (that would deadlock)', async () => {
    const ctx = await createTestContext();
    try {
      await expect(ctx.db.withTransaction(async () => ctx.db.query(`SELECT 1`))).rejects.toThrow(/Deadlock prevented/);
      await expect(ctx.db.withTransaction(async () => ctx.db.withTransaction(async () => 1))).rejects.toThrow(/Nested/);
      // ...and the driver is still usable afterwards.
      expect((await ctx.db.query<{ x: number }>(`SELECT 1 AS x`)).rows[0]!.x).toBe(1);
    } finally {
      await ctx.cleanup();
    }
  });
});
