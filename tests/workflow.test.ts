/**
 * Phase 1 acceptance criteria #5, #6, #7, #8, #9 — the issue state machine.
 *
 * The lifecycle is enforced by the backend, not the UI. Every test below drives the
 * real endpoints; none of them calls the domain directly for the assertion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowedTransitions, assertTransition, DomainError, TRANSITIONS } from '@campus/domain';
import { auth, createSpot, createTestContext, createIssueThroughWorkflow, errorCode, submitReport, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.cleanup();
});

const post = (url: string, token: string, payload: Record<string, unknown> = {}) =>
  ctx.app.inject({ method: 'POST', url, headers: auth(token), payload });

describe('Criterion 5 — a student cannot approve, claim or resolve an issue', () => {
  it('denies every workflow operation to a STUDENT', async () => {
    const issueId = await createIssueThroughWorkflow(ctx);

    const approve = await post(`/v1/issues/${issueId}/approve`, ctx.tokens.student);
    expect(approve.statusCode).toBe(403);
    expect(errorCode(approve)).toBe('FORBIDDEN');

    const claim = await post(`/v1/issues/${issueId}/claim`, ctx.tokens.student);
    expect(claim.statusCode).toBe(403);

    const start = await post(`/v1/issues/${issueId}/start`, ctx.tokens.student);
    expect(start.statusCode).toBe(403);

    const resolve = await post(`/v1/issues/${issueId}/resolve`, ctx.tokens.student, {
      resolutionNote: 'I fixed it myself, honest.',
    });
    expect(resolve.statusCode).toBe(403);

    // The issue must be exactly where it started.
    const row = await ctx.db.query<{ status: string; claimed_by_user_id: string | null }>(
      `SELECT status, claimed_by_user_id FROM issues WHERE id = $1`,
      [issueId],
    );
    expect(row.rows[0]!.status).toBe('SUBMITTED');
    expect(row.rows[0]!.claimed_by_user_id).toBeNull();
  });

  it('denies a STUDENT the operational issue queue', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/issues', headers: auth(ctx.tokens.student) });
    expect(res.statusCode).toBe(403);
  });
});

describe('Criterion 6 — an authorized HOD can perform permitted transitions', () => {
  it('walks SUBMITTED -> APPROVED -> IN_PROGRESS -> RESOLVED', async () => {
    const issueId = await createIssueThroughWorkflow(ctx);

    const claim = await post(`/v1/issues/${issueId}/claim`, ctx.tokens.hod);
    expect(claim.statusCode).toBe(200);
    expect(claim.json().issue.claimedByUserId).toBeTypeOf('string');

    const approve = await post(`/v1/issues/${issueId}/approve`, ctx.tokens.hod, { reason: 'Verified on site' });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().issue.status).toBe('APPROVED');
    expect(approve.json().issue.approvedAt).not.toBeNull();

    const start = await post(`/v1/issues/${issueId}/start`, ctx.tokens.hod);
    expect(start.statusCode).toBe(200);
    expect(start.json().issue.status).toBe('IN_PROGRESS');
    expect(start.json().issue.startedAt).not.toBeNull();

    const resolve = await post(`/v1/issues/${issueId}/resolve`, ctx.tokens.hod, {
      resolutionNote: 'Pipe joint replaced and sealed; area dried and repainted.',
    });
    expect(resolve.statusCode).toBe(200);
    const issue = resolve.json().issue;
    expect(issue.status).toBe('RESOLVED');
    expect(issue.resolvedAt).not.toBeNull();
    expect(issue.resolutionNote).toContain('Pipe joint replaced');
    expect(issue.overdue).toBe(false);
  });

  it('lets an HOD claim only once — a second HOD is rejected', async () => {
    const issueId = await createIssueThroughWorkflow(ctx);
    const first = await post(`/v1/issues/${issueId}/claim`, ctx.tokens.hod);
    expect(first.statusCode).toBe(200);

    // Promote student2 to HOD so we have a genuinely different operator.
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/admin/users', headers: auth(ctx.tokens.admin) });
    const target = list.json().items.find((u: { email: string }) => u.email === 'student2@demo.dsu.edu.in');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${target.id}/role`,
      headers: auth(ctx.tokens.admin),
      payload: { role: 'HOD' },
    });
    const secondHodLogin = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'student2@demo.dsu.edu.in', password: 'Demo#Passw0rd!2026' },
    });
    const secondToken = secondHodLogin.json().accessToken as string;

    const second = await post(`/v1/issues/${issueId}/claim`, secondToken);
    expect(second.statusCode).toBe(409);
    expect(errorCode(second)).toBe('ALREADY_CLAIMED');

    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${target.id}/role`,
      headers: auth(ctx.tokens.admin),
      payload: { role: 'STUDENT' },
    });
  });
});

describe('Criterion 7 — invalid transitions are rejected', () => {
  it('rejects skipping APPROVED (SUBMITTED -> IN_PROGRESS)', async () => {
    const issueId = await createIssueThroughWorkflow(ctx);
    const res = await post(`/v1/issues/${issueId}/start`, ctx.tokens.hod);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('INVALID_STATE_TRANSITION');
    expect(res.json().error.message).toContain('SUBMITTED');
  });

  it('rejects resolving an issue that is still SUBMITTED', async () => {
    const issueId = await createIssueThroughWorkflow(ctx);
    const res = await post(`/v1/issues/${issueId}/resolve`, ctx.tokens.hod, {
      resolutionNote: 'Skipping straight to done.',
    });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('INVALID_STATE_TRANSITION');
  });

  it('rejects re-approving an already APPROVED issue', async () => {
    const issueId = await createIssueThroughWorkflow(ctx);
    await post(`/v1/issues/${issueId}/approve`, ctx.tokens.hod);
    const res = await post(`/v1/issues/${issueId}/approve`, ctx.tokens.hod);
    expect(res.statusCode).toBe(409);
  });

  it('treats RESOLVED as terminal — no transition out of it', async () => {
    const issueId = await createIssueThroughWorkflow(ctx);
    await post(`/v1/issues/${issueId}/approve`, ctx.tokens.hod);
    await post(`/v1/issues/${issueId}/start`, ctx.tokens.hod);
    await post(`/v1/issues/${issueId}/resolve`, ctx.tokens.hod, { resolutionNote: 'Completed and verified on site.' });

    for (const path of ['approve', 'start', 'resolve']) {
      const res = await post(`/v1/issues/${issueId}/${path}`, ctx.tokens.hod, {
        resolutionNote: 'Attempting to reopen via a resolve call.',
      });
      expect(res.statusCode, `${path} must be rejected after RESOLVED`).toBe(409);
    }
  });

  it('exposes no generic status-update endpoint', async () => {
    const issueId = await createIssueThroughWorkflow(ctx);
    for (const method of ['PATCH', 'PUT'] as const) {
      const res = await ctx.app.inject({
        method,
        url: `/v1/issues/${issueId}`,
        headers: auth(ctx.tokens.hod),
        payload: { status: 'RESOLVED' },
      });
      // 404 (no such route) or 405 is acceptable; anything that mutates status is not.
      expect([404, 405]).toContain(res.statusCode);
    }
    const row = await ctx.db.query<{ status: string }>(`SELECT status FROM issues WHERE id = $1`, [issueId]);
    expect(row.rows[0]!.status).toBe('SUBMITTED');
  });
});

describe('Criterion 8 — resolution without a completion note is rejected', () => {
  it('rejects an empty completion note', async () => {
    const issueId = await createIssueThroughWorkflow(ctx);
    await post(`/v1/issues/${issueId}/approve`, ctx.tokens.hod);
    await post(`/v1/issues/${issueId}/start`, ctx.tokens.hod);

    const res = await post(`/v1/issues/${issueId}/resolve`, ctx.tokens.hod, { resolutionNote: '' });
    expect(res.statusCode).toBe(400);

    const row = await ctx.db.query<{ status: string }>(`SELECT status FROM issues WHERE id = $1`, [issueId]);
    expect(row.rows[0]!.status).toBe('IN_PROGRESS');
  });

  it('rejects resolving with no note field at all', async () => {
    const issueId = await createIssueThroughWorkflow(ctx);
    await post(`/v1/issues/${issueId}/approve`, ctx.tokens.hod);
    await post(`/v1/issues/${issueId}/start`, ctx.tokens.hod);
    const res = await post(`/v1/issues/${issueId}/resolve`, ctx.tokens.hod, {});
    expect(res.statusCode).toBe(400);
  });

  it('is also enforced at the DATA layer — the DB refuses a bare RESOLVED row', async () => {
    // Defence in depth: even a future bug in application code cannot persist this.
    // A bare RESOLVED update is blocked by a CHECK constraint (multiple guard the row;
    // whichever fires first, the write is refused with SQLSTATE 23514).
    const issueId = await createIssueThroughWorkflow(ctx);
    let code: string | undefined;
    try {
      await ctx.db.query(`UPDATE issues SET status = 'RESOLVED', resolved_at = now() WHERE id = $1`, [issueId]);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('23514'); // check_violation
  });

  it('rejects NULL and whitespace-only notes at the storage layer once other checks pass', async () => {
    // Isolate the resolution-note constraint by satisfying the lifecycle-timestamp
    // constraints first, so this proves THIS rule specifically.
    const issueId = await createIssueThroughWorkflow(ctx);

    for (const note of [null, '   ']) {
      let constraint: string | undefined;
      try {
        await ctx.db.query(
          `UPDATE issues
              SET status = 'RESOLVED',
                  resolved_at = now(),
                  approved_at = now(),
                  started_at = now(),
                  resolution_note = $2
            WHERE id = $1`,
          [issueId, note],
        );
      } catch (err) {
        constraint = (err as { constraint?: string }).constraint;
      }
      expect(constraint, `resolution_note=${JSON.stringify(note)} must be refused`).toBe('ck_issues_resolution_note');
    }

    // And a genuine note is accepted.
    await ctx.db.query(
      `UPDATE issues
          SET status = 'RESOLVED', resolved_at = now(), approved_at = now(), started_at = now(), resolution_note = $2
        WHERE id = $1`,
      [issueId, 'Replaced the corroded pipe section and verified no further seepage.'],
    );
    const row = await ctx.db.query<{ status: string }>(`SELECT status FROM issues WHERE id = $1`, [issueId]);
    expect(row.rows[0]!.status).toBe('RESOLVED');
  });

  it('rejects a whitespace-only note at the domain layer', () => {
    expect(() =>
      assertTransition({ from: 'IN_PROGRESS', to: 'RESOLVED', role: 'HOD', resolutionNote: '    ' }),
    ).toThrow(DomainError);
  });
});

describe('Criterion 9 — every valid transition is recorded in status history', () => {
  it('writes one history row per transition, with actor and reason', async () => {
    const issueId = await createIssueThroughWorkflow(ctx);
    await post(`/v1/issues/${issueId}/approve`, ctx.tokens.hod, { reason: 'Confirmed by inspection' });
    await post(`/v1/issues/${issueId}/start`, ctx.tokens.hod);
    await post(`/v1/issues/${issueId}/resolve`, ctx.tokens.hod, { resolutionNote: 'Replaced the tap washer.' });

    const rows = await ctx.db.query<{ previous_status: string | null; new_status: string; reason: string | null; changed_by_user_id: string }>(
      `SELECT previous_status, new_status, reason, changed_by_user_id FROM issue_status_history
        WHERE issue_id = $1 ORDER BY created_at ASC`,
      [issueId],
    );

    // Opening row + 3 transitions = 4.
    expect(rows.rows).toHaveLength(4);
    expect(rows.rows.map((r) => r.new_status)).toEqual(['SUBMITTED', 'APPROVED', 'IN_PROGRESS', 'RESOLVED']);
    expect(rows.rows[1]!.previous_status).toBe('SUBMITTED');
    expect(rows.rows[1]!.reason).toBe('Confirmed by inspection');
    expect(rows.rows.every((r) => r.changed_by_user_id)).toBe(true);

    // Surfaced through the API too, so clients render identical history.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/v1/issues/${issueId}`,
      headers: auth(ctx.tokens.hod),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().history).toHaveLength(4);
    expect(detail.json().history[3].newStatus).toBe('RESOLVED');
  });

  it('records history transactionally — a rejected transition writes nothing', async () => {
    const issueId = await createIssueThroughWorkflow(ctx);
    const before = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issue_status_history WHERE issue_id = $1`,
      [issueId],
    );
    await post(`/v1/issues/${issueId}/start`, ctx.tokens.hod); // invalid: SUBMITTED -> IN_PROGRESS
    const after = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issue_status_history WHERE issue_id = $1`,
      [issueId],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe('Response consistency — the app and the website must never disagree', () => {
  it('returns the SAME enriched projection from a transition as from GET /v1/issues/:id', async () => {
    const { spotId } = await createSpot(ctx);
    const first = await submitReport(ctx, ctx.tokens.student, { spotId, title: 'Consistency check defect' });
    // A second report so the master issue genuinely has a non-zero report count.
    await submitReport(ctx, ctx.tokens.student2, { spotId, title: 'Consistency check defect' });
    const issueId = first.json.issueId as string;

    await post(`/v1/issues/${issueId}/claim`, ctx.tokens.hod);
    const approve = await post(`/v1/issues/${issueId}/approve`, ctx.tokens.hod);
    expect(approve.statusCode).toBe(200);

    const fromTransition = approve.json().issue;
    const fromGet = (
      await ctx.app.inject({ method: 'GET', url: `/v1/issues/${issueId}`, headers: auth(ctx.tokens.hod) })
    ).json().issue;

    // Computed fields must survive the transition response. `report_count` in
    // particular is NOT a physical column, so `RETURNING *` silently dropped it.
    expect(fromTransition.reportCount).toBeGreaterThanOrEqual(2);
    expect(fromTransition.reportCount).toBe(fromGet.reportCount);
    expect(fromTransition.claimedByDisplayName).toBe(fromGet.claimedByDisplayName);
    expect(fromTransition.claimedByUserId).toBe(fromGet.claimedByUserId);
    expect(fromTransition.status).toBe(fromGet.status);
    expect(fromTransition.version).toBe(fromGet.version);

    // And the issue list must agree too.
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/issues', headers: auth(ctx.tokens.hod) });
    const fromList = list.json().items.find((i: { id: string }) => i.id === issueId);
    expect(fromList.reportCount).toBe(fromGet.reportCount);
    expect(fromList.status).toBe(fromGet.status);
  });
});

describe('State machine — pure unit tests', () => {
  it('permits exactly the three declared transitions', () => {
    expect(TRANSITIONS.map((t) => `${t.from}->${t.to}`)).toEqual([
      'SUBMITTED->APPROVED',
      'APPROVED->IN_PROGRESS',
      'IN_PROGRESS->RESOLVED',
    ]);
  });

  it('gives STUDENT no transitions from any state', () => {
    for (const status of ['SUBMITTED', 'APPROVED', 'IN_PROGRESS'] as const) {
      expect(allowedTransitions(status, 'STUDENT')).toHaveLength(0);
      expect(allowedTransitions(status, 'HOD').length).toBeGreaterThan(0);
    }
  });

  it('checks authorization BEFORE state validity (no workflow probing)', () => {
    // STUDENT attempting an illegal move must learn nothing about the workflow.
    try {
      assertTransition({ from: 'SUBMITTED', to: 'APPROVED', role: 'STUDENT' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('FORBIDDEN');
    }
  });

  it('requires the completion note only for RESOLVED', () => {
    expect(() => assertTransition({ from: 'SUBMITTED', to: 'APPROVED', role: 'HOD' })).not.toThrow();
    expect(() => assertTransition({ from: 'IN_PROGRESS', to: 'RESOLVED', role: 'HOD', resolutionNote: '' })).toThrow(
      DomainError,
    );
  });
});
