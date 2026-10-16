/**
 * 72-hour overdue rule — computed by the SERVER, filterable (Phase 5, audit item F7).
 * No mocks. `due_at` is backdated in the isolated test database to simulate elapsed time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createIssueThroughWorkflow, createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx?.cleanup();
});

const list = async (q: string) =>
  (await ctx.app.inject({ method: 'GET', url: `/v1/issues?${q}`, headers: auth(ctx.tokens.hod) })).json() as {
    items: { id: string; overdue: boolean; status: string; dueAt: string; createdAt: string }[];
  };

describe('overdue (72 h operational target)', () => {
  it('due_at is creation + 72 h, and a fresh ticket is not overdue', async () => {
    const id = await createIssueThroughWorkflow(ctx);
    const issue = (await list('limit=100')).items.find((i) => i.id === id)!;
    // due_at is computed by the application clock, created_at by the database clock: allow a
    // couple of seconds between the two, not a different rule.
    const gap = new Date(issue.dueAt).getTime() - new Date(issue.createdAt).getTime();
    expect(Math.abs(gap - 72 * 3600 * 1000)).toBeLessThan(2000);
    expect(issue.overdue).toBe(false);
    expect((await list('overdueOnly=true&limit=100')).items.map((i) => i.id)).not.toContain(id);
  });

  it('a past-due open ticket is flagged and returned by overdueOnly; a resolved one is not', async () => {
    const late = await createIssueThroughWorkflow(ctx);
    const lateButDone = await createIssueThroughWorkflow(ctx);
    await ctx.db.query(`UPDATE issues SET due_at = now() - interval '1 hour' WHERE id IN ($1, $2)`, [late, lateButDone]);
    for (const step of ['claim', 'approve', 'start']) {
      const r = await ctx.app.inject({ method: 'POST', url: `/v1/issues/${lateButDone}/${step}`, headers: auth(ctx.tokens.hod), payload: {} });
      expect(r.statusCode, `${step}: ${r.body}`).toBe(200);
    }
    const resolved = await ctx.app.inject({
      method: 'POST',
      url: `/v1/issues/${lateButDone}/resolve`,
      headers: auth(ctx.tokens.hod),
      payload: { resolutionNote: 'Replaced the fitting and tested it.' },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);

    const overdue = await list('overdueOnly=true&limit=100');
    const ids = overdue.items.map((i) => i.id);
    expect(ids).toContain(late);
    expect(ids).not.toContain(lateButDone);
    expect(overdue.items.every((i) => i.overdue && i.status !== 'RESOLVED' && i.status !== 'DUPLICATE')).toBe(true);
  });
});
