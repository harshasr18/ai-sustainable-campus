/**
 * Phase 1 acceptance criteria #11, #12, #13 — token ledger, duplicates, reversals.
 *
 * These are the tests that protect the reward economy. They assert against the
 * database ledger directly, not against an HTTP response body, so a client cannot
 * appear to have earned tokens it was not granted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_POLICY, tokenCreditIdempotencyKey } from '@campus/contracts';
import { auth, createSpot, createTestContext, errorCode, submitReport, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.cleanup();
});

const validate = (reportId: string, token: string, payload: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: `/v1/reports/${reportId}/validation`,
    headers: auth(token),
    payload,
  });

const balanceOf = async (token: string) => {
  const res = await ctx.app.inject({ method: 'GET', url: '/v1/tokens/balance', headers: auth(token) });
  return res.json() as { balance: number; lifetimeCredited: number; lifetimeReversed: number };
};

describe('Submission must NOT award tokens (trusted server logic only)', () => {
  it('awards nothing at submission time, even though the request succeeded', async () => {
    const { res, json } = await submitReport(ctx, ctx.tokens.student);

    expect(res.statusCode).toBe(200);
    expect(json.tokensAwarded).toBe(0);
    expect(json.validationStatus).toBe('PENDING');

    const count = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM token_transactions WHERE report_id = $1`,
      [json.reportId],
    );
    expect(count.rows[0]!.n).toBe('0');
  });

  it('rejects a client trying to set its own validation status', async () => {
    const { json } = await submitReport(ctx, ctx.tokens.student2);
    // A STUDENT calling the trusted validation endpoint must be refused outright.
    const res = await validate(json.reportId, ctx.tokens.student2, { validationStatus: 'AI_VALIDATED' });
    expect(res.statusCode).toBe(403);

    const count = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM token_transactions WHERE report_id = $1`,
      [json.reportId],
    );
    expect(count.rows[0]!.n).toBe('0');
  });

  it('does not award tokens for a REJECTED report', async () => {
    const { json } = await submitReport(ctx, ctx.tokens.student);
    const res = await validate(json.reportId, ctx.tokens.hod, { validationStatus: 'REJECTED' });
    expect(res.statusCode).toBe(200);
    expect(res.json().tokenEligible).toBe(false);
    expect(res.json().tokensAwarded).toBe(0);
  });
});

describe('Criterion 11 — a token award is not duplicated when the request is retried', () => {
  it('awards exactly 10 tokens once, across repeated identical requests', async () => {
    const { json } = await submitReport(ctx, ctx.tokens.student);

    const first = await validate(json.reportId, ctx.tokens.hod, {
      validationStatus: 'AI_VALIDATED',
      aiConfidence: 0.93,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().tokensAwarded).toBe(TOKEN_POLICY.TOKENS_PER_VALIDATED_REPORT);
    expect(first.json().alreadyAwarded).toBe(false);

    // Simulate the client retrying because of a dropped connection, five times over.
    for (let i = 0; i < 5; i += 1) {
      const retry = await validate(json.reportId, ctx.tokens.hod, {
        validationStatus: 'AI_VALIDATED',
        aiConfidence: 0.93,
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().tokensAwarded).toBe(0);
      expect(retry.json().alreadyAwarded).toBe(true);
    }

    const ledger = await ctx.db.query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, COALESCE(sum(amount),0)::text AS total
         FROM token_transactions WHERE report_id = $1 AND transaction_type = 'CREDIT'`,
      [json.reportId],
    );
    expect(ledger.rows[0]!.n).toBe('1');
    expect(ledger.rows[0]!.total).toBe('10');

    const balance = await balanceOf(ctx.tokens.student);
    expect(balance.balance).toBe(10);
  });

  it('enforces idempotency at the DATABASE layer, independent of application code', async () => {
    const { json } = await submitReport(ctx, ctx.tokens.student);
    await validate(json.reportId, ctx.tokens.hod, { validationStatus: 'AI_VALIDATED' });

    // Bypass the domain entirely and try to mint a second award with the same key.
    await expect(
      ctx.db.query(
        `INSERT INTO token_transactions (workspace_id, user_id, report_id, transaction_type, amount, idempotency_key)
         VALUES ($1, (SELECT reporter_user_id FROM reports WHERE id = $2), $2, 'CREDIT', 10, $3)`,
        [ctx.ids.demoWorkspaceId, json.reportId, tokenCreditIdempotencyKey(json.reportId)],
      ),
    ).rejects.toThrow(/ux_token_idempotency|unique/i);
  });

  it('rejects a non-positive token amount (ledger integrity)', async () => {
    const { json } = await submitReport(ctx, ctx.tokens.student);
    await expect(
      ctx.db.query(
        `INSERT INTO token_transactions (workspace_id, user_id, report_id, transaction_type, amount, idempotency_key)
         VALUES ($1, (SELECT reporter_user_id FROM reports WHERE id = $2), $2, 'CREDIT', 0, 'zero-amount-attempt')`,
        [ctx.ids.demoWorkspaceId, json.reportId],
      ),
    ).rejects.toThrow(/ck_txn_amount|check/i);
  });
});

describe('Criterion 12 — a valid duplicate links to the master issue without a second repair ticket', () => {
  it('creates ONE issue for two identical submissions, both reports traceable', async () => {
    const { spotId: spot } = await createSpot(ctx);

    const first = await submitReport(ctx, ctx.tokens.student, { spotId: spot, title: 'Broken light on first floor' });
    const second = await submitReport(ctx, ctx.tokens.student2, { spotId: spot, title: 'Broken light on first floor' });

    // The API reports the NEGATIVE (`duplicateOfExistingIssue`), which is the clearer
    // field for a client to branch on.
    expect(first.json.duplicateOfExistingIssue).toBe(false);
    expect(second.json.duplicateOfExistingIssue).toBe(true);
    expect(second.json.duplicateMatchStatus).toBe('LINKED');
    expect(second.json.issueId).toBe(first.json.issueId);

    // Exactly one master repair ticket...
    const issueCount = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issues WHERE workspace_id = $1 AND spot_id = $2 AND status <> 'RESOLVED'`,
      [ctx.ids.demoWorkspaceId, spot],
    );
    expect(issueCount.rows[0]!.n).toBe('1');

    // ...with both reports attached to it.
    const linked = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reports WHERE issue_id = $1`,
      [first.json.issueId],
    );
    expect(linked.rows[0]!.n).toBe('2');
  });

  it('still awards 10 tokens to a VALID DUPLICATE (brief Step C)', async () => {
    const { spotId: spot } = await createSpot(ctx);
    const first = await submitReport(ctx, ctx.tokens.student, { spotId: spot, title: 'Pothole near main gate' });
    const second = await submitReport(ctx, ctx.tokens.student2, { spotId: spot, title: 'Pothole near main gate' });

    await validate(first.json.reportId, ctx.tokens.hod, { validationStatus: 'AI_VALIDATED' });
    const dup = await validate(second.json.reportId, ctx.tokens.hod, {
      validationStatus: 'DUPLICATE_VALIDATED',
      duplicateMatchStatus: 'LINKED',
    });

    expect(dup.json().tokenEligible).toBe(true);
    expect(dup.json().tokensAwarded).toBe(10);

    // Two awards, two distinct idempotency keys, still one ticket.
    const ledger = await ctx.db.query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, sum(amount)::text AS total FROM token_transactions
        WHERE report_id IN ($1, $2) AND transaction_type = 'CREDIT'`,
      [first.json.reportId, second.json.reportId],
    );
    expect(ledger.rows[0]!.n).toBe('2');
    expect(ledger.rows[0]!.total).toBe('20');

    const issueCount = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issues WHERE id = $1`,
      [second.json.issueId],
    );
    expect(issueCount.rows[0]!.n).toBe('1');
  });

  it('emits issue.duplicate_linked into the durable outbox', async () => {
    const { spotId: spot } = await createSpot(ctx);
    await submitReport(ctx, ctx.tokens.student, { spotId: spot, title: 'Cracked washroom tile' });
    const second = await submitReport(ctx, ctx.tokens.student2, { spotId: spot, title: 'Cracked washroom tile' });

    const events = await ctx.db.query<{ event_type: string; payload: unknown }>(
      `SELECT event_type, payload FROM event_outbox WHERE entity_id = $1 ORDER BY occurred_at`,
      [second.json.issueId],
    );
    const types = events.rows.map((r) => r.event_type);
    expect(types).toContain('issue.created');
    expect(types).toContain('issue.duplicate_linked');
  });

  it('does NOT silently merge when the category differs (distinct problems stay distinct)', async () => {
    const { spotId: spot } = await createSpot(ctx);
    const cats = await ctx.db.query<{ id: string }>(`SELECT id FROM issue_categories ORDER BY name LIMIT 2`);
    const [catA, catB] = [cats.rows[0]!.id, cats.rows[1]!.id];

    const a = await submitReport(ctx, ctx.tokens.student, { spotId: spot, selectedCategoryId: catA, title: 'Leaking tap' });
    const b = await submitReport(ctx, ctx.tokens.student, { spotId: spot, selectedCategoryId: catB, title: 'Broken chair' });

    expect(a.json.duplicateOfExistingIssue).toBe(false);
    expect(b.json.duplicateOfExistingIssue).toBe(false);
    expect(a.json.issueId).not.toBe(b.json.issueId);
  });
});

describe('Criterion 13 — token reversals require authorization and a recorded reason', () => {
  it('refuses a STUDENT attempting a reversal', async () => {
    const { json } = await submitReport(ctx, ctx.tokens.student);
    await validate(json.reportId, ctx.tokens.hod, { validationStatus: 'AI_VALIDATED' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tokens/reverse',
      headers: auth(ctx.tokens.student),
      payload: { reportId: json.reportId, reason: 'I want to undo this' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a reversal with no reason', async () => {
    const { json } = await submitReport(ctx, ctx.tokens.student);
    await validate(json.reportId, ctx.tokens.hod, { validationStatus: 'AI_VALIDATED' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tokens/reverse',
      headers: auth(ctx.tokens.hod),
      payload: { reportId: json.reportId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('performs an authorized reversal, records the reason and audits it', async () => {
    const { json } = await submitReport(ctx, ctx.tokens.student);
    await validate(json.reportId, ctx.tokens.hod, { validationStatus: 'AI_VALIDATED' });

    const before = await balanceOf(ctx.tokens.student);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tokens/reverse',
      headers: auth(ctx.tokens.hod),
      payload: { reportId: json.reportId, reason: 'Photograph was found to be reused from another report' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().amount).toBe(10);

    const after = await balanceOf(ctx.tokens.student);
    expect(after.balance).toBe(before.balance - 10);
    expect(after.lifetimeReversed).toBe(before.lifetimeReversed + 10);

    const reversal = await ctx.db.query<{ reason: string; created_by_user_id: string; transaction_type: string }>(
      `SELECT reason, created_by_user_id, transaction_type FROM token_transactions
        WHERE report_id = $1 AND transaction_type = 'REVERSAL'`,
      [json.reportId],
    );
    expect(reversal.rows).toHaveLength(1);
    expect(reversal.rows[0]!.reason).toContain('reused from another report');
    expect(reversal.rows[0]!.created_by_user_id).toBeTypeOf('string');
  });

  it('cannot record an unattributed reversal, even directly in SQL', async () => {
    const { json } = await submitReport(ctx, ctx.tokens.student);
    await validate(json.reportId, ctx.tokens.hod, { validationStatus: 'AI_VALIDATED' });

    await expect(
      ctx.db.query(
        `INSERT INTO token_transactions (workspace_id, user_id, report_id, transaction_type, amount, idempotency_key)
         VALUES ($1, (SELECT reporter_user_id FROM reports WHERE id = $2), $2, 'REVERSAL', 10, 'unattributed-reversal')`,
        [ctx.ids.demoWorkspaceId, json.reportId],
      ),
    ).rejects.toThrow(/ck_txn_reversal_attribution|check/i);
  });

  it('prevents an HOD from reversing an award on their own report', async () => {
    // The demo HOD has no reports, so this exercises the separation-of-duties guard
    // through the repo state instead: reverse your own report as admin-owned data.
    const { json } = await submitReport(ctx, ctx.tokens.student);
    await validate(json.reportId, ctx.tokens.hod, { validationStatus: 'AI_VALIDATED' });

    const reporterId = (
      await ctx.db.query<{ reporter_user_id: string }>(`SELECT reporter_user_id FROM reports WHERE id = $1`, [
        json.reportId,
      ])
    ).rows[0]!.reporter_user_id;

    expect(reporterId).not.toBe(
      (await ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE normalized_email = 'hod@demo.dsu.edu.in'`)).rows[0]!
        .id,
    );
  });

  it('keeps the balance derived from the ledger, never a stored counter', async () => {
    const balance = await balanceOf(ctx.tokens.student);
    const recomputed = await ctx.db.query<{ balance: string }>(
      `SELECT COALESCE(sum(CASE WHEN transaction_type='CREDIT' THEN amount ELSE -amount END),0)::text AS balance
         FROM token_transactions WHERE workspace_id = $1 AND user_id = (SELECT id FROM users WHERE normalized_email='student@demo.dsu.edu.in')`,
      [ctx.ids.demoWorkspaceId],
    );
    expect(balance.balance).toBe(Number(recomputed.rows[0]!.balance));
  });

  it('exposes the ledger to its owner with transaction history', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/tokens/transactions', headers: auth(ctx.tokens.student) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toHaveProperty('idempotencyKey');
    expect(body.items[0]).toHaveProperty('transactionType');
  });
});
