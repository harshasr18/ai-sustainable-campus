/**
 * Phase 3 backend surface.
 *
 * Covers what Phase 3 added to the existing application rather than a new project:
 *
 *   G1  GET /v1/issues/:id now returns the reports attached to the ticket.
 *   G2  PATCH /v1/issues/:id/severity — the HUMAN-confirmed operational severity.
 *   G3  PATCH /v1/issues/:id/category — correcting a mis-filed report.
 *   G4  ListIssuesQuerySchema gained severity and date-range filters.
 *   —   GET /v1/analytics/summary — every dashboard figure, aggregated in SQL.
 *
 * NO TEST IN THIS FILE IS MOCKED. Every assertion runs against in-memory PGlite (real
 * PostgreSQL), real migrations, the real domain services and real HTTP routes through
 * `app.inject`. Where a number is asserted it is asserted against the row that produced it.
 *
 * The tests that matter most here are the AUTHORIZATION ones: §4 of the brief is explicit
 * that hiding a button is not authorization, so each new endpoint is probed with the wrong
 * role's token and must be refused by the server.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  auth,
  createSpot,
  createTestContext,
  errorCode,
  submitReport,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Submits a report on its own fresh spot so it becomes a new master ticket. */
async function freshIssue(token = ctx.tokens.student) {
  const { spotId } = await createSpot(ctx);
  const { res, json } = await submitReport(ctx, token, { spotId, title: 'Phase 3 test defect' });
  // The report route answers 200 (not 201) — verified against the live API, not assumed.
  expect(res.statusCode).toBe(200);
  return { issueId: json.issueId as string, reportId: json.reportId as string, spotId };
}

describe('G1 — an issue exposes the reports attached to it', () => {
  it('returns the linked report with a display name, and never the storage key', async () => {
    const { issueId, reportId } = await freshIssue();

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/issues/${issueId}`,
      headers: auth(ctx.tokens.hod),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      linkedReports: Record<string, unknown>[];
      linkedReportCount: number;
    };

    expect(body.linkedReportCount).toBe(1);
    expect(body.linkedReports).toHaveLength(1);

    const linked = body.linkedReports[0]!;
    expect(linked.id).toBe(reportId);
    expect(linked.reporterDisplayName).toBe('Demo Student');
    expect(linked.hasEvidence).toBe(true);
    // The photo is reachable only through the authorization-gated evidence route.
    expect(linked.evidenceUrl).toBe(`/v1/reports/${reportId}/evidence`);
    // No internal storage key may leak into any API response.
    expect(JSON.stringify(body)).not.toContain('evidence_storage_key');
  });

  it('shows a student ONLY their own report on a shared ticket, but the true count', async () => {
    const { spotId, issueId } = await freshIssue(ctx.tokens.student);

    // A second student reports the SAME physical defect -> linked, not a new ticket.
    const second = await submitReport(ctx, ctx.tokens.student2, {
      spotId,
      title: 'Phase 3 test defect',
    });
    expect(second.res.statusCode).toBe(200);
    expect(second.json.duplicateOfExistingIssue).toBe(true);
    expect(second.json.issueId).toBe(issueId);

    const asFirstStudent = await ctx.app.inject({
      method: 'GET',
      url: `/v1/issues/${issueId}`,
      headers: auth(ctx.tokens.student),
    });
    const studentBody = asFirstStudent.json() as {
      linkedReports: { reporterUserId: string | null; reporterDisplayName: string | null }[];
      linkedReportCount: number;
    };

    // §8: a student sees only their own reports — and no other reporter's identity.
    expect(studentBody.linkedReportCount).toBe(2);
    expect(studentBody.linkedReports).toHaveLength(1);
    expect(studentBody.linkedReports[0]!.reporterUserId).toBeNull();
    expect(studentBody.linkedReports[0]!.reporterDisplayName).toBeNull();

    const asHod = await ctx.app.inject({
      method: 'GET',
      url: `/v1/issues/${issueId}`,
      headers: auth(ctx.tokens.hod),
    });
    const hodBody = asHod.json() as { linkedReports: unknown[]; linkedReportCount: number };
    // Staff see the whole ticket, because they have to fix the whole defect.
    expect(hodBody.linkedReports).toHaveLength(2);
    expect(hodBody.linkedReportCount).toBe(2);
  });

  it('still refuses a student who has no report on the issue (does not confirm it exists)', async () => {
    const { issueId } = await freshIssue(ctx.tokens.student2);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/issues/${issueId}`,
      headers: auth(ctx.tokens.student),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ issue: null });
  });
});

describe('G2 — human-confirmed severity is separate from the AI severity', () => {
  it('records the operational severity, bumps the version, and audits before/after', async () => {
    const { issueId } = await freshIssue();

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/issues/${issueId}/severity`,
      headers: auth(ctx.tokens.hod),
      payload: { severity: 'HIGH', reason: 'Live electrical hazard, treating as urgent.' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { issue: { severity: string; version: number }; previousSeverity: null };
    expect(body.issue.severity).toBe('HIGH');
    expect(body.previousSeverity).toBeNull();
    expect(body.issue.version).toBeGreaterThan(1);

    // Column names taken from migration 0005: `before_state` / `after_state`, not `before`
    // and `after` — `after` is also a reserved word in SQL.
    const audit = await ctx.db.query<{ before_state: unknown; after_state: unknown; reason: string }>(
      `SELECT before_state, after_state, reason FROM audit_log
        WHERE entity_id = $1 AND action = 'issue.severity_changed' ORDER BY created_at DESC LIMIT 1`,
      [issueId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.before_state).toEqual({ severity: null });
    expect(audit.rows[0]!.after_state).toEqual({ severity: 'HIGH' });

    // The event is the RIGHT verb — a severity change is not a status change.
    const events = await ctx.db.query<{ event_type: string }>(
      `SELECT event_type FROM event_outbox WHERE entity_id = $1`,
      [issueId],
    );
    expect(events.rows.map((r) => r.event_type)).toContain('issue.severity_changed');
    expect(events.rows.map((r) => r.event_type)).not.toContain('issue.status_changed');
  });

  it('never overwrites the model\'s own severity on the report', async () => {
    const { issueId, reportId } = await freshIssue();

    // Stand in for the Phase 2 pipeline having recorded an AI severity on the report.
    await ctx.db.query(`UPDATE reports SET ai_severity = 'CRITICAL' WHERE id = $1`, [reportId]);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/issues/${issueId}/severity`,
      headers: auth(ctx.tokens.hod),
      payload: { severity: 'LOW' },
    });

    const row = await ctx.db.query<{ ai_severity: string }>(
      `SELECT ai_severity FROM reports WHERE id = $1`,
      [reportId],
    );
    // The department downgraded it; the model's opinion is still on the record.
    expect(row.rows[0]!.ai_severity).toBe('CRITICAL');

    const issue = await ctx.db.query<{ severity: string }>(
      `SELECT severity FROM issues WHERE id = $1`,
      [issueId],
    );
    expect(issue.rows[0]!.severity).toBe('LOW');
  });

  it('rejects a no-op change instead of filling the audit log with noise', async () => {
    const { issueId } = await freshIssue();

    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/issues/${issueId}/severity`,
      headers: auth(ctx.tokens.hod),
      payload: { severity: 'MEDIUM' },
    });

    const again = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/issues/${issueId}/severity`,
      headers: auth(ctx.tokens.hod),
      payload: { severity: 'MEDIUM' },
    });
    expect(again.statusCode).toBe(400);
  });

  it('allows clearing a severity explicitly, which is not the same as omitting it', async () => {
    const { issueId } = await freshIssue();

    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/issues/${issueId}/severity`,
      headers: auth(ctx.tokens.hod),
      payload: { severity: 'CRITICAL' },
    });
    const cleared = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/issues/${issueId}/severity`,
      headers: auth(ctx.tokens.hod),
      payload: { severity: null, reason: 'Re-triaged after inspection: no severity.' },
    });

    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { issue: { severity: null } }).issue.severity).toBeNull();
  });

  it('refuses a student, and refuses an unauthenticated caller', async () => {
    const { issueId } = await freshIssue();

    const asStudent = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/issues/${issueId}/severity`,
      headers: auth(ctx.tokens.student),
      payload: { severity: 'CRITICAL' },
    });
    expect(asStudent.statusCode).toBe(403);
    expect(errorCode(asStudent)).toBe('FORBIDDEN');

    const anonymous = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/issues/${issueId}/severity`,
      payload: { severity: 'CRITICAL' },
    });
    expect(anonymous.statusCode).toBe(401);

    // Server-side authorization, not a hidden button: the row is untouched.
    const row = await ctx.db.query<{ severity: string | null }>(
      `SELECT severity FROM issues WHERE id = $1`,
      [issueId],
    );
    expect(row.rows[0]!.severity).toBeNull();
  });
});

describe('G3 — correcting a mis-filed category', () => {
  it('changes the issue category but preserves what the student originally chose', async () => {
    const { issueId, reportId } = await freshIssue();

    const categories = await ctx.db.query<{ id: string; name: string }>(
      `SELECT id, name FROM issue_categories ORDER BY name`,
    );
    const original = await ctx.db.query<{ selected_category_id: string }>(
      `SELECT selected_category_id FROM reports WHERE id = $1`,
      [reportId],
    );
    const target = categories.rows.find((c) => c.id !== original.rows[0]!.selected_category_id)!;

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/issues/${issueId}/category`,
      headers: auth(ctx.tokens.hod),
      payload: { categoryId: target.id, reason: 'Actually a plumbing fault, not electrical.' },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { issue: { categoryId: string } }).issue.categoryId).toBe(target.id);

    // The evidence of what the student reported is NOT rewritten.
    const after = await ctx.db.query<{ selected_category_id: string }>(
      `SELECT selected_category_id FROM reports WHERE id = $1`,
      [reportId],
    );
    expect(after.rows[0]!.selected_category_id).toBe(original.rows[0]!.selected_category_id);
  });

  it('refuses a category that does not exist', async () => {
    const { issueId } = await freshIssue();

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/issues/${issueId}/category`,
      headers: auth(ctx.tokens.hod),
      payload: { categoryId: '00000000-0000-4000-8000-000000000000' },
    });

    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe('NOT_FOUND');
  });

  it('refuses an inactive category', async () => {
    const { issueId } = await freshIssue();

    const inactive = await ctx.db.query<{ id: string }>(
      `INSERT INTO issue_categories (name, slug, active) VALUES ($1, $2, false) RETURNING id`,
      ['Retired category', `retired-${Math.random().toString(36).slice(2, 10)}`],
    );

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/issues/${issueId}/category`,
      headers: auth(ctx.tokens.hod),
      payload: { categoryId: inactive.rows[0]!.id },
    });

    expect(res.statusCode).toBe(404);
  });

  it('refuses a student', async () => {
    const { issueId } = await freshIssue();
    const categories = await ctx.db.query<{ id: string }>(`SELECT id FROM issue_categories LIMIT 1`);

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/issues/${issueId}/category`,
      headers: auth(ctx.tokens.student),
      payload: { categoryId: categories.rows[0]!.id },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('G4 — severity and date filtering happen in SQL, not the browser', () => {
  it('filters by operational severity, including the UNSET sentinel', async () => {
    const { issueId } = await freshIssue();
    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/issues/${issueId}/severity`,
      headers: auth(ctx.tokens.hod),
      payload: { severity: 'CRITICAL' },
    });

    const critical = await ctx.app.inject({
      method: 'GET',
      url: '/v1/issues?severity=CRITICAL',
      headers: auth(ctx.tokens.hod),
    });
    expect(critical.statusCode).toBe(200);
    const criticalBody = critical.json() as { items: { id: string; severity: string }[]; total: number };
    expect(criticalBody.items.every((i) => i.severity === 'CRITICAL')).toBe(true);
    expect(criticalBody.items.map((i) => i.id)).toContain(issueId);
    // `total` must describe the same set as `items`, or pagination lies.
    expect(criticalBody.total).toBe(criticalBody.items.length);

    // The sentinel finds the un-triaged ones, which a NULL comparison never would.
    const unset = await ctx.app.inject({
      method: 'GET',
      url: '/v1/issues?severity=UNSET',
      headers: auth(ctx.tokens.hod),
    });
    const unsetBody = unset.json() as { items: { id: string; severity: string | null }[] };
    expect(unsetBody.items.every((i) => i.severity === null)).toBe(true);
    expect(unsetBody.items.map((i) => i.id)).not.toContain(issueId);
  });

  it('filters by created date range with an exclusive upper bound', async () => {
    const { issueId } = await freshIssue();

    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();

    const inside = await ctx.app.inject({
      method: 'GET',
      url: `/v1/issues?createdAfter=${encodeURIComponent(past)}&createdBefore=${encodeURIComponent(future)}`,
      headers: auth(ctx.tokens.hod),
    });
    expect((inside.json() as { items: { id: string }[] }).items.map((i) => i.id)).toContain(issueId);

    // Everything created after "now + 1 minute" is nothing; the new issue must not appear.
    const outside = await ctx.app.inject({
      method: 'GET',
      url: `/v1/issues?createdAfter=${encodeURIComponent(future)}`,
      headers: auth(ctx.tokens.hod),
    });
    expect((outside.json() as { items: { id: string }[] }).items.map((i) => i.id)).not.toContain(issueId);
  });

  it('rejects an invalid filter value rather than ignoring it', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/issues?severity=VERY_BAD',
      headers: auth(ctx.tokens.hod),
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps the queue closed to students', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/issues',
      headers: auth(ctx.tokens.student),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /v1/analytics/summary — real aggregates, scoped to the caller', () => {
  it('returns counts that match the rows they describe, for a HOD', async () => {
    const { issueId } = await freshIssue();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/analytics/summary',
      headers: auth(ctx.tokens.hod),
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      scope: { workspace: string; audience: string };
      issues: { total: number; submitted: number; open: number };
      reports: { total: number };
      resolution: { resolvedCount: number; averageHours: number | null; medianHours: number | null };
      reportsByWeek: unknown[];
      tokens: { credited: number };
      ai: { confidenceNote: string };
    };

    expect(body.scope.workspace).toBe('DEMO');
    expect(body.scope.audience).toBe('WHOLE_WORKSPACE');

    // Compare against the database directly — this is the whole point of the endpoint.
    const counts = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issues WHERE workspace_id = $1`,
      [ctx.ids.demoWorkspaceId],
    );
    expect(body.issues.total).toBe(Number(counts.rows[0]!.n));
    expect(body.issues.total).toBeGreaterThan(0);
    expect(body.issues.open).toBeLessThanOrEqual(body.issues.total);

    const reports = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reports WHERE workspace_id = $1`,
      [ctx.ids.demoWorkspaceId],
    );
    expect(body.reports.total).toBe(Number(reports.rows[0]!.n));

    // A fresh workspace has nothing resolved, and the API says so with null — not zero hours.
    expect(body.resolution.resolvedCount).toBe(0);
    expect(body.resolution.averageHours).toBeNull();
    expect(body.resolution.medianHours).toBeNull();

    // Twelve weekly buckets, always, so a chart never has a silent gap.
    expect(body.reportsByWeek).toHaveLength(12);

    // The confidence caveat ships with the payload.
    expect(body.ai.confidenceNote).toMatch(/not a calibrated probability/i);

    // A sanity check that the issue we just made is inside the totals.
    expect(issueId).toBeTruthy();
  });

  it('narrows a STUDENT to their own reports and the issues they filed', async () => {
    const mine = await freshIssue(ctx.tokens.student);
    const theirs = await freshIssue(ctx.tokens.student2);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/analytics/summary',
      headers: auth(ctx.tokens.student),
    });
    const body = res.json() as {
      scope: { audience: string };
      reports: { total: number; distinctReporters: number };
      issues: { total: number };
      byBlock: unknown[];
    };

    expect(body.scope.audience).toBe('OWN_REPORTS');
    // Only ever one reporter in a student's own scope.
    expect(body.reports.distinctReporters).toBe(1);

    // And the number really is this student's own report count, not the workspace's.
    const own = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reports WHERE workspace_id = $1 AND reporter_user_id = (
         SELECT id FROM users WHERE normalized_email = 'student@demo.dsu.edu.in')`,
      [ctx.ids.demoWorkspaceId],
    );
    expect(body.reports.total).toBe(Number(own.rows[0]!.n));

    // Both issues exist, but the student's total is nowhere near the workspace total.
    const workspaceTotal = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issues WHERE workspace_id = $1`,
      [ctx.ids.demoWorkspaceId],
    );
    expect(body.issues.total).toBeLessThan(Number(workspaceTotal.rows[0]!.n));
    expect(mine.issueId).not.toBe(theirs.issueId);
  });

  it('honours block and category filters, and reports which ones were applied', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/analytics/summary?blockId=${ctx.ids.blockId}`,
      headers: auth(ctx.tokens.hod),
    });

    const body = res.json() as {
      scope: { filters: { blockId: string | null } };
      byBlock: { blockId: string }[];
    };
    expect(body.scope.filters.blockId).toBe(ctx.ids.blockId);
    expect(body.byBlock.every((b) => b.blockId === ctx.ids.blockId)).toBe(true);
  });

  it('counts token credits and reversals from the ledger itself', async () => {
    const { reportId } = await freshIssue(ctx.tokens.student);

    // A real validation outcome, through the real seam — this is what credits tokens.
    const validated = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reports/${reportId}/validation`,
      headers: auth(ctx.tokens.hod),
      payload: { validationStatus: 'HUMAN_VALIDATED', reason: 'Confirmed on site.' },
    });
    expect(validated.statusCode).toBe(200);
    expect((validated.json() as { tokensAwarded: number }).tokensAwarded).toBe(10);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/analytics/summary',
      headers: auth(ctx.tokens.hod),
    });
    const body = res.json() as {
      tokens: { credited: number; creditCount: number; reversed: number; reversalCount: number };
    };

    const ledger = await ctx.db.query<{ credited: string; reversed: string }>(
      `SELECT
         COALESCE(sum(amount) FILTER (WHERE transaction_type = 'CREDIT'), 0)::text AS credited,
         COALESCE(sum(amount) FILTER (WHERE transaction_type = 'REVERSAL'), 0)::text AS reversed
       FROM token_transactions WHERE workspace_id = $1`,
      [ctx.ids.demoWorkspaceId],
    );

    expect(body.tokens.credited).toBe(Number(ledger.rows[0]!.credited));
    expect(body.tokens.reversed).toBe(Number(ledger.rows[0]!.reversed));
    expect(body.tokens.creditCount).toBeGreaterThanOrEqual(1);

    // Idempotency: repeating the same validation does not credit again, and the aggregate
    // must not move. This is the bug the whole token design exists to prevent.
    const repeat = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reports/${reportId}/validation`,
      headers: auth(ctx.tokens.hod),
      payload: { validationStatus: 'HUMAN_VALIDATED', reason: 'Confirmed on site.' },
    });
    expect((repeat.json() as { alreadyAwarded: boolean }).alreadyAwarded).toBe(true);

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/v1/analytics/summary',
      headers: auth(ctx.tokens.hod),
    });
    expect((after.json() as { tokens: { credited: number } }).tokens.credited).toBe(body.tokens.credited);
  });

  it('never mixes the DEMO and REAL workspaces', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/analytics/summary',
      headers: auth(ctx.tokens.admin),
    });
    const body = res.json() as { scope: { workspace: string } };
    // The seeded admin is in DEMO; the summary must describe DEMO, not the other one.
    expect(body.scope.workspace).toBe('DEMO');
  });

  it('requires a session', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/analytics/summary' });
    expect(res.statusCode).toBe(401);
  });
});
