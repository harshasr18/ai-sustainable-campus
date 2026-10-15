/**
 * Phase 1 acceptance criterion — "For AI-specific behavior not yet implemented, test
 * the interface contract and failure states rather than pretending the model is
 * operational."
 *
 * Plus the shared-contract guarantees the student app and the admin website depend on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AI_REVIEW_CONFIDENCE_THRESHOLD,
  ApiErrorSchema,
  CreateReportRequestSchema,
  EVENT_TYPES,
  EVENT_TYPES as ALL_EVENTS,
  EventEnvelopeSchema,
  LoginRequestSchema,
  TOKEN_POLICY,
  tokenCreditIdempotencyKey,
} from '@campus/contracts';
import {
  computeDedupeKey,
  createAiAnalyzer,
  haversineMeters,
  requiresHumanReview,
  UnconfiguredAiAnalyzer,
} from '@campus/domain';
import { auth, createTestContext, errorCode, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.cleanup();
});

/**
 * REWRITTEN FOR PHASE 2 (audit risk R9).
 *
 * These assertions previously asserted that the AI boundary was IMPLEMENTED-NOWHERE.
 * Phase 2 supplies a real provider, so the tests now assert the property that actually
 * matters and will still matter later: an UNCONFIGURED deployment must fail loudly and
 * must never produce a fabricated prediction, while a CONFIGURED one is exercised by
 * tests/ai-provider.test.ts. Deleting these would have made the suite greener and the
 * system less honest.
 */
describe('AI adapter contract — the boundary exists and fails honestly', () => {
  it('the default analyzer is unconfigured and throws NOT_IMPLEMENTED', async () => {
    const analyzer = createAiAnalyzer();
    expect(analyzer).toBeInstanceOf(UnconfiguredAiAnalyzer);
    // Called with a well-formed request, exactly as the Phase 2 worker will call it.
    await expect(
      analyzer.analyze({
        reportId: crypto.randomUUID(),
        evidenceRef: 'local://demo/2026/10/example.png',
        mimeType: 'image/png',
        selectedCategorySlug: 'water-leakage',
        blockId: crypto.randomUUID(),
        spotId: crypto.randomUUID(),
        latitude: null,
        longitude: null,
        submittedAt: new Date(),
        candidateCategories: [
          { id: crypto.randomUUID(), slug: 'water-leakage', name: 'Water Leakage', description: null },
        ],
      }),
    ).rejects.toThrow(/not configured/i);
  });

  it('the analyze endpoint returns 501 rather than a fabricated prediction', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reports/${crypto.randomUUID()}/analyze`,
      headers: auth(ctx.tokens.hod),
    });
    // 501 is the honest answer while no provider is configured. A 200 with an invented
    // aiConfidence would be a lie.
    expect(res.statusCode).toBe(501);
    expect(errorCode(res)).toBe('NOT_IMPLEMENTED');
  });

  it('never writes a fake analysis row', async () => {
    const rows = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ai_analyses`);
    expect(rows.rows[0]!.n).toBe('0');
  });

  it('routes anything uncertain to human review', () => {
    // Low confidence, a category disagreement, or ANY duplicate candidate -> human.
    expect(requiresHumanReview({ confidence: 0.4, categoryMatchesStudentSelection: true, duplicateCandidateCount: 0 })).toBe(true);
    expect(requiresHumanReview({ confidence: 0.99, categoryMatchesStudentSelection: false, duplicateCandidateCount: 0 })).toBe(true);
    expect(requiresHumanReview({ confidence: 0.99, categoryMatchesStudentSelection: true, duplicateCandidateCount: 1 })).toBe(true);
    expect(requiresHumanReview({ confidence: null, categoryMatchesStudentSelection: null, duplicateCandidateCount: 0 })).toBe(true);
    // Only a confident, agreeing, unambiguous result may skip review.
    expect(
      requiresHumanReview({
        confidence: AI_REVIEW_CONFIDENCE_THRESHOLD + 0.05,
        categoryMatchesStudentSelection: true,
        duplicateCandidateCount: 0,
      }),
    ).toBe(false);
  });
});

describe('Real-time contract — defined, durable, and NOT claimed as live', () => {
  it('declares the Phase 1 event types plus the Phase 2 AI events, and nothing else', () => {
    /**
     * REWRITTEN FOR PHASE 2 (audit risk R9). Phase 1 asserted exactly nine types; the
     * brief's §17 adds seven AI-pipeline events. The assertion is kept EXACT on purpose:
     * adding an event type must be a deliberate act that updates this list, which is
     * what stops a typo in an event name reaching the outbox unnoticed.
     */
    const phase1 = [
      'report.created',
      'report.validated',
      'issue.created',
      'issue.duplicate_linked',
      'issue.status_changed',
      'issue.claimed',
      'issue.resolved',
      'token.credited',
      'token.reversed',
    ];
    const phase2Ai = [
      'report.analysis_started',
      'report.analysis_completed',
      'report.analysis_failed',
      'report.review_required',
      'report.duplicate_candidate_found',
      'report.linked_to_master_issue',
      'report.duplicate_rejected',
    ];
    expect(ALL_EVENTS).toEqual([...phase1, ...phase2Ai]);
    // Every Phase 1 verb survives untouched — clients written against them still work.
    for (const verb of phase1) expect(ALL_EVENTS).toContain(verb);
  });

  it('reports liveTransport as NOT_IMPLEMENTED and the outbox as the delivery mode', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/events/types', headers: auth(ctx.tokens.student) });
    expect(res.statusCode).toBe(200);
    expect(res.json().eventTypes).toEqual(EVENT_TYPES);
    expect(res.json().deliveryMode).toBe('transactional-outbox');
    expect(res.json().liveTransport).toBe('NOT_IMPLEMENTED');
  });

  it('returns 501 for the live stream endpoint instead of pretending', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/events/stream', headers: auth(ctx.tokens.student) });
    expect(res.statusCode).toBe(501);
    expect(errorCode(res)).toBe('NOT_IMPLEMENTED');
  });

  it('validates event envelopes against the shared schema', () => {
    const ok = EventEnvelopeSchema.safeParse({
      eventId: crypto.randomUUID(),
      eventType: 'issue.status_changed',
      occurredAt: new Date().toISOString(),
      workspace: 'DEMO',
      entityType: 'ISSUE',
      entityId: crypto.randomUUID(),
      entityVersion: 2,
      actorUserId: null,
      payload: { from: 'SUBMITTED', to: 'APPROVED' },
    });
    expect(ok.success).toBe(true);

    const bad = EventEnvelopeSchema.safeParse({
      eventId: crypto.randomUUID(),
      eventType: 'issue.exploded', // not a declared event
      occurredAt: new Date().toISOString(),
      workspace: 'DEMO',
      entityType: 'ISSUE',
      entityId: crypto.randomUUID(),
      entityVersion: 1,
      actorUserId: null,
      payload: {},
    });
    expect(bad.success).toBe(false);
  });

  it('carries the workspace on every event so delivery cannot cross the boundary', async () => {
    const rows = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event_outbox WHERE workspace_id IS NULL`,
    );
    expect(rows.rows[0]!.n).toBe('0');

    const mismatched = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event_outbox e
        JOIN issues i ON i.id = e.entity_id
       WHERE e.workspace_id <> i.workspace_id`,
    );
    expect(mismatched.rows[0]!.n).toBe('0');
  });
});

describe('Shared contract guarantees', () => {
  it('exposes a stable token policy that clients cannot redefine', () => {
    expect(TOKEN_POLICY.TOKENS_PER_VALIDATED_REPORT).toBe(10);
    expect(TOKEN_POLICY.ELIGIBLE_VALIDATION_STATUSES).toContain('DUPLICATE_VALIDATED');
    expect(TOKEN_POLICY.DEFAULT_OVERDUE_HOURS).toBe(72);
  });

  it('derives a deterministic idempotency key per report', () => {
    const id = 'a1b2c3d4-0000-0000-0000-000000000000';
    expect(tokenCreditIdempotencyKey(id)).toBe(`report:${id}:validated-credit`);
    expect(tokenCreditIdempotencyKey(id)).toBe(tokenCreditIdempotencyKey(id));
  });

  it('produces a stable dedupe key for the same physical defect', () => {
    const input = { blockId: 'b1', spotId: 's1', categoryId: 'c1' } as const;
    expect(computeDedupeKey(input)).toBe(computeDedupeKey({ ...input }));
    expect(computeDedupeKey(input)).not.toBe(computeDedupeKey({ ...input, categoryId: 'c2' }));
    expect(computeDedupeKey(input)).toBe('s:s1:c:c1');
    expect(computeDedupeKey({ ...input, granularity: 'block_category' })).toBe('b:b1:c:c1');
  });

  it('computes proximity for the Phase 2 duplicate candidate search', () => {
    // Same point -> 0 m. ~0.001 degrees of latitude is ~111 m.
    expect(haversineMeters({ latitude: 12.86, longitude: 77.55 }, { latitude: 12.86, longitude: 77.55 })).toBeCloseTo(0, 5);
    expect(haversineMeters({ latitude: 12.86, longitude: 77.55 }, { latitude: 12.861, longitude: 77.55 })).toBeGreaterThan(100);
    expect(haversineMeters({ latitude: 12.86, longitude: 77.55 }, { latitude: 12.861, longitude: 77.55 })).toBeLessThan(120);
  });

  it('rejects a report payload without a block, spot or category', () => {
    expect(CreateReportRequestSchema.safeParse({ title: 'No location' }).success).toBe(false);
    expect(
      CreateReportRequestSchema.safeParse({
        blockId: crypto.randomUUID(),
        spotId: crypto.randomUUID(),
        selectedCategoryId: crypto.randomUUID(),
        title: 'Valid title here',
      }).success,
    ).toBe(true);
  });

  it('normalizes email BEFORE validating its shape', () => {
    const r = LoginRequestSchema.safeParse({ email: '  Someone@DSU.edu.in ', password: 'long-enough-password' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe('someone@dsu.edu.in');
  });

  it('every error code the API can emit is declared in the shared contract', async () => {
    const declare = new Set(ApiErrorSchema.shape.error.shape.code.options);
    const probes: { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; payload?: unknown }[] = [
      { url: '/v1/tokens/balance' },
      { url: '/v1/tokens/balance', headers: auth('bogus') },
      { url: '/v1/issues', headers: auth(ctx.tokens.student) },
      { url: '/v1/does-not-exist' },
      { url: '/v1/events/stream', headers: auth(ctx.tokens.student) },
    ];

    for (const probe of probes) {
      const res = await ctx.app.inject({
        method: probe.method ?? 'GET',
        url: probe.url,
        ...(probe.headers ? { headers: probe.headers } : {}),
        ...(probe.payload ? { payload: probe.payload } : {}),
      });
      const parsed = ApiErrorSchema.safeParse(res.json());
      expect(parsed.success, `${probe.url} returned a non-conforming error body: ${res.body}`).toBe(true);
      if (parsed.success) expect(declare.has(parsed.data.error.code)).toBe(true);
    }
  });
});

describe('Dashboard API — supports the Phase 3 admin website', () => {
  it('returns authoritative counts scoped to the caller workspace', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/dashboard/summary',
      headers: auth(ctx.tokens.hod),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope.workspace).toBe('DEMO');
    expect(body.counts).toHaveProperty('submitted');
    expect(body.counts).toHaveProperty('resolved');
    expect(body.counts).toHaveProperty('total');
    expect(Array.isArray(body.byBlock)).toBe(true);
    expect(Array.isArray(body.byCategory)).toBe(true);
  });

  it('does not expose a dashboard to a STUDENT', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/dashboard/summary',
      headers: auth(ctx.tokens.student),
    });
    expect(res.statusCode).toBe(403);
  });
});
