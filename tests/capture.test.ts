/**
 * Phase 5 — server-issued capture tickets and idempotent submission (migration 0009).
 *
 * Integration tests over the real HTTP app and an in-memory PGlite database. No mocks.
 *
 * What these tests establish is deliberately narrow, matching what the mechanism can
 * honestly claim: a report needs an unexpired, unused ticket that belongs to the submitter;
 * one ticket yields at most one report, even under concurrent retries; and byte-identical
 * photographs are refused. They do NOT (and cannot) show the bytes came from a camera.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSpot,
  createTestContext,
  errorCode,
  issueCaptureToken,
  submitReport,
  TINY_PNG,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx?.cleanup();
});

describe('capture tickets — a report needs a live, server-issued ticket', () => {
  it('issues a ticket with a server timestamp and an expiry, storing only its hash', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/reports/capture-sessions',
      headers: { authorization: `Bearer ${ctx.tokens.student}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { captureToken: string; captureSessionId: string; issuedAt: string; expiresAt: string };
    expect(body.captureToken.length).toBeGreaterThanOrEqual(40);
    expect(new Date(body.expiresAt).getTime() - new Date(body.issuedAt).getTime()).toBe(15 * 60 * 1000);

    const row = await ctx.db.query<{ token_hash: string }>(`SELECT token_hash FROM capture_sessions WHERE id = $1`, [
      body.captureSessionId,
    ]);
    expect(row.rows[0]!.token_hash).not.toBe(body.captureToken);
    expect(row.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a submission without a ticket', async () => {
    const { res } = await submitReport(ctx, ctx.tokens.student, { captureToken: null });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
    expect(res.body).toMatch(/captureToken/);
  });

  it('refuses a ticket that was never issued', async () => {
    const { res } = await submitReport(ctx, ctx.tokens.student, { captureToken: randomBytes(32).toString('base64url') });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('CAPTURE_SESSION_INVALID');
  });

  it("refuses another user's ticket", async () => {
    const othersTicket = await issueCaptureToken(ctx, ctx.tokens.student2);
    const { res } = await submitReport(ctx, ctx.tokens.student, { captureToken: othersTicket });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('CAPTURE_SESSION_INVALID');
  });

  it('refuses an expired ticket and asks for a retake', async () => {
    const ticket = await issueCaptureToken(ctx, ctx.tokens.student);
    await ctx.db.query(
      `UPDATE capture_sessions SET issued_at = now() - interval '40 minutes', expires_at = now() - interval '25 minutes'
        WHERE consumed_at IS NULL AND issued_at > now() - interval '1 minute'`,
    );
    const { res } = await submitReport(ctx, ctx.tokens.student, { captureToken: ticket });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('CAPTURE_SESSION_EXPIRED');
    expect(res.json().error.message).toMatch(/retake/i);
  });
});

describe('idempotent submission — one ticket, one report', () => {
  it('a repeated request with the same ticket returns the SAME report, not a second one', async () => {
    const { spotId } = await createSpot(ctx);
    const ticket = await issueCaptureToken(ctx, ctx.tokens.student);
    const photo = Buffer.concat([TINY_PNG, randomBytes(12)]);

    const first = await submitReport(ctx, ctx.tokens.student, { spotId, captureToken: ticket, photo, exactPhoto: true });
    const second = await submitReport(ctx, ctx.tokens.student, { spotId, captureToken: ticket, photo, exactPhoto: true });

    expect(first.res.statusCode).toBe(200);
    expect(second.res.statusCode).toBe(200);
    expect(first.json.replayed).toBe(false);
    expect(second.json.replayed).toBe(true);
    expect(second.json.reportId).toBe(first.json.reportId);
    expect(second.json.issueId).toBe(first.json.issueId);

    const rows = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM reports WHERE spot_id = $1`, [spotId]);
    expect(rows.rows[0]!.n).toBe(1);
  });

  it('six CONCURRENT requests with one ticket create exactly one report', async () => {
    const { spotId } = await createSpot(ctx);
    const ticket = await issueCaptureToken(ctx, ctx.tokens.student);
    const photo = Buffer.concat([TINY_PNG, randomBytes(12)]);

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        submitReport(ctx, ctx.tokens.student, { spotId, captureToken: ticket, photo, exactPhoto: true }),
      ),
    );
    for (const r of results) expect(r.res.statusCode).toBe(200);
    const ids = new Set(results.map((r) => r.json.reportId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.json.replayed === false)).toHaveLength(1);

    const rows = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM reports WHERE spot_id = $1`, [spotId]);
    expect(rows.rows[0]!.n).toBe(1);
  });

  it('a byte-identical photograph is refused even with a fresh ticket', async () => {
    const photo = Buffer.concat([TINY_PNG, randomBytes(12)]);
    const a = await submitReport(ctx, ctx.tokens.student, { spotId: (await createSpot(ctx)).spotId, photo, exactPhoto: true });
    expect(a.res.statusCode).toBe(200);
    const b = await submitReport(ctx, ctx.tokens.student2, { spotId: (await createSpot(ctx)).spotId, photo, exactPhoto: true });
    expect(b.res.statusCode).toBe(409);
    expect(errorCode(b.res)).toBe('EVIDENCE_REUSED');
  });

  it('records the server timestamp, the ticket, the photo hash and untrusted capture metadata', async () => {
    const { spotId } = await createSpot(ctx);
    const { json } = await submitReport(ctx, ctx.tokens.student, { spotId });
    const row = await ctx.db.query<{
      submitted_at: Date;
      capture_session_id: string;
      evidence_sha256: string;
      issued_at: Date;
      consumed_at: Date;
    }>(
      `SELECT r.submitted_at, r.capture_session_id, r.evidence_sha256, c.issued_at, c.consumed_at
         FROM reports r JOIN capture_sessions c ON c.id = r.capture_session_id
        WHERE r.id = $1`,
      [json.reportId],
    );
    const r = row.rows[0]!;
    expect(r.evidence_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(r.issued_at).getTime()).toBeLessThanOrEqual(new Date(r.submitted_at).getTime());
    expect(r.consumed_at).not.toBeNull();
    expect(json.submittedAt).toBe(new Date(r.submitted_at).toISOString());
  });
});
