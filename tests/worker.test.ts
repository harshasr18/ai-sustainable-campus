/**
 * Background analysis worker (Phase 4 §4, §8, §12).
 *
 * ── MOCKED MODEL — READ THIS FIRST ──────────────────────────────────────────
 * Every test here uses a STUB analyzer (`stubAnalyzer` below), not the real CLIP model.
 * That is deliberate and it limits what these tests can claim:
 *
 *   PROVEN HERE: the queue mechanics — what gets picked up, how often, when it stops,
 *   what is persisted, who it is attributed to, and that nothing is ever credited.
 *
 *   NOT PROVEN HERE: anything about model quality. A stub returns whatever it is told
 *   to. Genuine inference on real photographs is covered separately, opt-in, by
 *   tests/ai-genuine.test.ts, and end to end against a running server by
 *   `npm run worker:verify`.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Every test drives `worker.sweep()` directly instead of starting the timer, so results
 * are deterministic and the suite never waits on a poll interval.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiPermanentError, type AiAnalysisRequest, type AiAnalyzer } from '@campus/domain';
import type { AiAnalysisResult } from '@campus/contracts';
import { createAnalysisWorker } from '../apps/api/src/worker.js';
import { createSpot, createTestContext, submitReport, type TestContext } from './helpers.js';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

/** MOCK. Counts calls; either answers with a fixed verdict or throws. */
function stubAnalyzer(behaviour: 'succeed' | 'review' | 'fail' | 'fail-permanent', provider = 'stub-for-tests') {
  const calls: string[] = [];
  const analyzer: AiAnalyzer = {
    provider,
    model: 'stub-model',
    modelVersion: 'test',
    async analyze(request: AiAnalysisRequest): Promise<AiAnalysisResult> {
      calls.push(request.reportId);
      if (behaviour === 'fail') throw new Error('simulated transient inference failure');
      if (behaviour === 'fail-permanent') {
        throw new AiPermanentError('simulated unusable photograph', 'AI_INVALID_EVIDENCE');
      }
      const chosen = request.candidateCategories.find((c) => c.slug === request.selectedCategorySlug);
      return {
        reportId: request.reportId,
        provider,
        model: 'stub-model',
        modelVersion: 'test',
        status: behaviour === 'succeed' ? 'SUCCEEDED' : 'NEEDS_HUMAN_REVIEW',
        predictedCategoryId: chosen?.id ?? null,
        categoryMatchesStudentSelection: true,
        confidence: behaviour === 'succeed' ? 0.91 : 0.41,
        severity: null,
        repairRecommendation: null,
        duplicateCandidates: [],
        requiresHumanReview: behaviour !== 'succeed',
      };
    },
  };
  return { analyzer, calls };
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** A fresh spot per report, so dedupe never links two tests' reports to one issue. */
async function freshReport(): Promise<string> {
  const { spotId } = await createSpot(ctx);
  const { res, json } = await submitReport(ctx, ctx.tokens.student, { spotId });
  expect(res.statusCode).toBe(200);
  return json.reportId as string;
}

async function analysesFor(reportId: string) {
  const r = await ctx.db.query<{ status: string }>(
    `SELECT status FROM ai_analyses WHERE report_id = $1 ORDER BY created_at`,
    [reportId],
  );
  return r.rows.map((row) => row.status);
}

async function creditsFor(reportId: string): Promise<number> {
  const r = await ctx.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM token_transactions WHERE report_id = $1`,
    [reportId],
  );
  return Number(r.rows[0]!.n);
}

describe('Analysis worker [MOCKED analyzer — queue mechanics only]', () => {
  it('analyses a pending report without any client request, exactly once', async () => {
    const reportId = await freshReport();
    const { analyzer, calls } = stubAnalyzer('succeed');
    const worker = createAnalysisWorker({ db: ctx.db, ai: analyzer, intervalMs: 1000, maxAttempts: 3, log: silentLog });

    await worker.sweep();
    expect(calls.filter((id) => id === reportId)).toHaveLength(1);
    expect(await analysesFor(reportId)).toEqual(['SUCCEEDED']);

    // Further sweeps — standing in for further ticks, or a restart — must not reprocess it.
    await worker.sweep();
    await worker.sweep();
    expect(calls.filter((id) => id === reportId)).toHaveLength(1);
    expect(await analysesFor(reportId)).toEqual(['SUCCEEDED']);
  });

  it('a NEW worker instance (a process restart) does not re-analyse finished work', async () => {
    const reportId = await freshReport();
    const first = stubAnalyzer('review');
    await createAnalysisWorker({ db: ctx.db, ai: first.analyzer, intervalMs: 1000, maxAttempts: 3, log: silentLog }).sweep();
    expect(await analysesFor(reportId)).toEqual(['NEEDS_HUMAN_REVIEW']);

    // The second instance starts with empty memory; only the database can stop it.
    const second = stubAnalyzer('succeed');
    await createAnalysisWorker({ db: ctx.db, ai: second.analyzer, intervalMs: 1000, maxAttempts: 3, log: silentLog }).sweep();
    expect(second.calls).not.toContain(reportId);
    expect(await analysesFor(reportId)).toEqual(['NEEDS_HUMAN_REVIEW']);
  });

  /*
   * The AI-validation policy (Phase 5). Business rule: 10 tokens for every successfully
   * AI-validated submission. The SERVER decides, inside the analysis transaction, from
   * schema-validated facts: SUCCEEDED + category agreement + still PENDING. The analyzer is a
   * MOCK here — these tests exercise the policy and the ledger, not the model.
   */
  it('a SUCCEEDED analysis that agrees with the student credits exactly 10 tokens, once', async () => {
    const reportId = await freshReport();
    const { analyzer } = stubAnalyzer('succeed');
    await createAnalysisWorker({ db: ctx.db, ai: analyzer, intervalMs: 1000, maxAttempts: 3, log: silentLog }).sweep();

    expect(await creditsFor(reportId)).toBe(1);
    const r = await ctx.db.query<{ validation_status: string; ai_confidence: number; amount: number; created_by_user_id: string | null }>(
      `SELECT r.validation_status, r.ai_confidence, t.amount, t.created_by_user_id
         FROM reports r JOIN token_transactions t ON t.report_id = r.id WHERE r.id = $1`,
      [reportId],
    );
    expect(r.rows[0]!.validation_status).toBe('AI_VALIDATED');
    expect(r.rows[0]!.amount).toBe(10);
    expect(r.rows[0]!.created_by_user_id).toBeNull(); // the server's policy, not a person
    expect(r.rows[0]!.ai_confidence).toBeCloseTo(0.91);
  });

  it('re-running analysis on a validated report never credits a second time', async () => {
    const reportId = await freshReport();
    const { analyzer } = stubAnalyzer('succeed');
    await createAnalysisWorker({ db: ctx.db, ai: analyzer, intervalMs: 1000, maxAttempts: 3, log: silentLog }).sweep();
    // Force a second pipeline run directly, as the manual /analyze route would.
    const { runAnalysis } = await import('../apps/api/src/routes/analysis.js');
    const again = await runAnalysis(ctx.db, analyzer, ctx.ids.demoWorkspaceId, reportId, null, 'DEMO');
    expect(again.autoValidated).toBe(false);
    expect(await creditsFor(reportId)).toBe(1);
  });

  it('NEEDS_HUMAN_REVIEW and FAILED analyses credit nothing and leave the report PENDING', async () => {
    for (const behaviour of ['review', 'fail'] as const) {
      const reportId = await freshReport();
      const { analyzer } = stubAnalyzer(behaviour);
      await createAnalysisWorker({ db: ctx.db, ai: analyzer, intervalMs: 1000, maxAttempts: 3, log: silentLog }).sweep();
      expect(await creditsFor(reportId)).toBe(0);
      const r = await ctx.db.query<{ validation_status: string }>(`SELECT validation_status FROM reports WHERE id = $1`, [reportId]);
      expect(r.rows[0]!.validation_status).toBe('PENDING');
    }
  });

  it('a report an HOD already REJECTED is never credited by a later analysis', async () => {
    const reportId = await freshReport();
    await ctx.db.query(`UPDATE reports SET validation_status = 'REJECTED' WHERE id = $1`, [reportId]);
    const { analyzer } = stubAnalyzer('succeed');
    const { runAnalysis } = await import('../apps/api/src/routes/analysis.js');
    const out = await runAnalysis(ctx.db, analyzer, ctx.ids.demoWorkspaceId, reportId, null, 'DEMO');
    expect(out.status).toBe('SUCCEEDED');
    expect(out.autoValidated).toBe(false);
    expect(await creditsFor(reportId)).toBe(0);
  });

  it('a duplicate-LINKED report is credited too — each genuine submission earns its own 10', async () => {
    const { spotId } = await createSpot(ctx);
    const first = await submitReport(ctx, ctx.tokens.student, { spotId });
    const second = await submitReport(ctx, ctx.tokens.student2, { spotId });
    expect(second.json.duplicateOfExistingIssue).toBe(true);
    expect(second.json.issueId).toBe(first.json.issueId);
    const { analyzer } = stubAnalyzer('succeed');
    const worker = createAnalysisWorker({ db: ctx.db, ai: analyzer, intervalMs: 1000, maxAttempts: 3, log: silentLog });
    await worker.sweep();
    await worker.sweep();
    expect(await creditsFor(first.json.reportId)).toBe(1);
    expect(await creditsFor(second.json.reportId)).toBe(1);
  });

  it('retries a failing report up to the attempt limit, then stops for good', async () => {
    const reportId = await freshReport();
    const { analyzer, calls } = stubAnalyzer('fail');
    const worker = createAnalysisWorker({ db: ctx.db, ai: analyzer, intervalMs: 1000, maxAttempts: 3, log: silentLog });

    for (let i = 0; i < 6; i += 1) await worker.sweep();

    // Three attempts, each persisted as an explicit FAILED row — then nothing, however long
    // the worker keeps running. No infinite retry loop (§4).
    expect(calls.filter((id) => id === reportId)).toHaveLength(3);
    expect(await analysesFor(reportId)).toEqual(['FAILED', 'FAILED', 'FAILED']);
    expect(await creditsFor(reportId)).toBe(0);

    const r = await ctx.db.query<{ validation_status: string }>(
      `SELECT validation_status FROM reports WHERE id = $1`,
      [reportId],
    );
    // A failed analysis must not erase the report or mark it validated: still PENDING, still
    // recoverable by an operator through POST /v1/reports/:id/analyze.
    expect(r.rows[0]!.validation_status).toBe('PENDING');
  });

  it('a PERMANENT failure (unusable photo) is attempted once, never retried', async () => {
    const reportId = await freshReport();
    const { analyzer, calls } = stubAnalyzer('fail-permanent');
    const worker = createAnalysisWorker({ db: ctx.db, ai: analyzer, intervalMs: 1000, maxAttempts: 3, log: silentLog });

    for (let i = 0; i < 4; i += 1) await worker.sweep();

    expect(calls.filter((id) => id === reportId)).toHaveLength(1);
    expect(await analysesFor(reportId)).toEqual(['FAILED']);
    expect(await creditsFor(reportId)).toBe(0);
  });

  it('two overlapping sweeps in ONE process analyse a report once', async () => {
    const reportId = await freshReport();
    const { analyzer, calls } = stubAnalyzer('succeed');
    const worker = createAnalysisWorker({ db: ctx.db, ai: analyzer, intervalMs: 1000, maxAttempts: 3, log: silentLog });

    await Promise.all([worker.sweep(), worker.sweep()]);
    expect(calls.filter((id) => id === reportId)).toHaveLength(1);
    expect(await analysesFor(reportId)).toEqual(['SUCCEEDED']);
  });

  it('attributes its work to no human and keeps it in the report\'s own workspace', async () => {
    const reportId = await freshReport();
    const { analyzer } = stubAnalyzer('review');
    await createAnalysisWorker({ db: ctx.db, ai: analyzer, intervalMs: 1000, maxAttempts: 3, log: silentLog }).sweep();

    const events = await ctx.db.query<{ event_type: string; workspace_id: string; actor_user_id: string | null }>(
      `SELECT event_type, workspace_id, actor_user_id FROM event_outbox
        WHERE entity_id = $1 AND event_type IN ('report.analysis_completed', 'report.review_required')
        ORDER BY event_type`,
      [reportId],
    );
    expect(events.rows.map((e) => e.event_type)).toEqual(['report.analysis_completed', 'report.review_required']);
    for (const event of events.rows) {
      expect(event.workspace_id).toBe(ctx.ids.demoWorkspaceId);
      expect(event.actor_user_id).toBeNull();
    }

    const audit = await ctx.db.query<{ actor_user_id: string | null }>(
      `SELECT actor_user_id FROM audit_log WHERE entity_id = $1 AND action = 'report.ai_analyzed'`,
      [reportId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.actor_user_id).toBeNull();
  });

  it('with AI_PROVIDER=unconfigured, start() records no attempts at all', async () => {
    const reportId = await freshReport();
    const { analyzer, calls } = stubAnalyzer('succeed', 'unconfigured');
    const worker = createAnalysisWorker({ db: ctx.db, ai: analyzer, intervalMs: 20, maxAttempts: 3, log: silentLog });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await worker.stop();

    // Not three failures per report — none. Otherwise switching AI on later would find every
    // queued report's attempt budget already spent.
    expect(calls).toHaveLength(0);
    expect(await analysesFor(reportId)).toEqual([]);
  });
});
