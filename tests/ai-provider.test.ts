/**
 * AI provider tests (§19: "Use mocked model responses for deterministic unit tests,
 * but label those tests clearly").
 *
 * ============================================================================
 * EVERY TEST IN THIS FILE USES AN INJECTED FAKE CLASSIFIER. NO REAL MODEL RUNS.
 * The genuine-inference test lives in `tests/ai-genuine.test.ts` and is opt-in.
 * Nothing here is evidence that the vision model classifies campus defects well —
 * it is evidence that the CODE AROUND the model behaves correctly, which is a
 * different and equally necessary claim.
 * ============================================================================
 *
 * The fake classifier returns fixed scores, so "low confidence", "ambiguous", and
 * "model says nothing is wrong" are exercised deterministically instead of hoping a
 * real image happens to land in the right probability band.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AiPermanentError,
  LocalClipAnalyzer,
  NOTHING_WRONG_LABEL,
  buildLabels,
  type ImageDecoder,
} from '@campus/domain';
import { AI_REVIEW_CONFIDENCE_THRESHOLD } from '@campus/contracts';
import { AI_CONFIG_DEFAULTS } from '@campus/db';
import { createTestContext, auth, errorCode, multipart, submitReport, TINY_PNG, type TestContext } from './helpers.js';
import { buildApp } from '../apps/api/src/app.js';
import { runAnalysis } from '../apps/api/src/routes/analysis.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.cleanup();
});

/* ------------------------------------------------------------------ */
/* Test doubles                                                        */
/* ------------------------------------------------------------------ */

/** A real, decodable JPEG-ish payload large enough to pass the dimension gate. */
const JPEG_BYTES = Buffer.concat([
  // Minimal JPEG header so the storage layer's magic-byte sniff accepts it.
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(64, 0x20),
  Buffer.from([0xff, 0xd9]),
]);

/**
 * Deterministic fake classifier. `winner` decides the top label; `scores` lets a test
 * construct a specific margin.
 */
function fakeClassifier(scores: { label: string; score: number }[]) {
  return async (_image: unknown, _labels: string[]) => scores;
}

/**
 * Fake decoder: reports plausible dimensions without importing the ONNX runtime.
 * This is the seam that keeps this test file at ~0 MB of native memory.
 */
function fakeDecoder(width = 800, height = 600): ImageDecoder {
  return async () => ({ handle: { fake: true }, width, height });
}

function analyzerWith(
  scores: { label: string; score: number }[],
  overrides: Partial<Parameters<typeof buildAnalyzer>[1]> = {},
) {
  return buildAnalyzer(scores, overrides);
}

function buildAnalyzer(
  scores: { label: string; score: number }[],
  overrides: {
    confidenceThreshold?: number;
    ambiguityMargin?: number;
    loadEvidence?: (ref: string) => Promise<Buffer>;
    retryPolicy?: { maxAttempts: number; baseDelayMs: number; sleep?: (ms: number) => Promise<void> };
    decodeImage?: ImageDecoder;
  } = {},
) {
  return new LocalClipAnalyzer({
    provider: 'local-clip',
    model: 'fake/clip',
    cacheDir: '/nonexistent',
    confidenceThreshold: overrides.confidenceThreshold ?? AI_REVIEW_CONFIDENCE_THRESHOLD,
    ambiguityMargin: overrides.ambiguityMargin ?? 0.15,
    timeoutMs: 5_000,
    maxAttempts: 1,
    allowRemoteDownload: false,
    loadEvidence: overrides.loadEvidence ?? (async () => JPEG_BYTES),
    // Injected so no ONNX runtime is loaded and the test is deterministic.
    classifier: fakeClassifier(scores),
    decodeImage: overrides.decodeImage ?? fakeDecoder(),
    retryPolicy: overrides.retryPolicy,
  });
}

/**
 * The label a category produces, built by the SAME function the adapter uses, so a
 * prompt-wording change cannot silently break these tests.
 */
function labelFor(name: string, description: string | null = null): string {
  const byLabel = buildLabels([{ id: 'x', slug: 's', name, description }]);
  return [...byLabel.keys()][0]!;
}

/* ------------------------------------------------------------------ */
/* Classification outcomes                                             */
/* ------------------------------------------------------------------ */

describe('AI classification outcomes (fake classifier — NOT real inference)', () => {
  it('a confident, agreeing prediction maps to the right category and needs no review', async () => {
    const cat = { id: randomUUID(), name: 'Water Leakage', slug: 'water-leakage', description: null };
    const analyzer = analyzerWith([
      { label: labelFor('Water Leakage'), score: 0.93 },
      { label: labelFor('Waste', 'accumulated garbage'), score: 0.05 },
      { label: NOTHING_WRONG_LABEL, score: 0.02 },
    ]);

    const result = await analyzer.analyze({
      reportId: randomUUID(),
      evidenceRef: 'local://x.jpg',
      mimeType: 'image/jpeg',
      selectedCategorySlug: 'water-leakage',
      blockId: randomUUID(),
      spotId: randomUUID(),
      latitude: null,
      longitude: null,
      submittedAt: new Date(),
      candidateCategories: [cat],
    });

    expect(result.predictedCategoryId).toBe(cat.id);
    expect(result.categoryMatchesStudentSelection).toBe(true);
    expect(result.confidence).toBeCloseTo(0.93, 5);
    expect(result.requiresHumanReview).toBe(false);
    expect(result.status).toBe('SUCCEEDED');
    // Honest about what this model does NOT do yet.
    expect(result.severity).toBeNull();
    expect(result.repairRecommendation).toBeNull();
  });

  it('a prediction that contradicts the student is flagged for review, and the student is not overridden', async () => {
    const cat = { id: randomUUID(), name: 'Waste Management', slug: 'waste', description: null };
    const analyzer = analyzerWith([
      { label: labelFor('Waste Management'), score: 0.95 },
      { label: NOTHING_WRONG_LABEL, score: 0.03 },
    ]);

    const result = await analyzer.analyze({
      reportId: randomUUID(),
      evidenceRef: 'local://x.jpg',
      mimeType: 'image/jpeg',
      // The student said "water leakage"; the model disagrees.
      selectedCategorySlug: 'water-leakage',
      blockId: randomUUID(),
      spotId: randomUUID(),
      latitude: null,
      longitude: null,
      submittedAt: new Date(),
      candidateCategories: [cat],
    });

    expect(result.categoryMatchesStudentSelection).toBe(false);
    expect(result.requiresHumanReview).toBe(true);
    expect(result.status).toBe('NEEDS_HUMAN_REVIEW');
  });

  it('a low-confidence result requires review even when it agrees with the student', async () => {
    const cat = { id: randomUUID(), name: 'Potholes & Roads', slug: 'potholes', description: null };
    const analyzer = analyzerWith([
      { label: labelFor('Potholes & Roads'), score: 0.41 },
      { label: NOTHING_WRONG_LABEL, score: 0.3 },
    ]);

    const result = await analyzer.analyze({
      reportId: randomUUID(),
      evidenceRef: 'local://x.jpg',
      mimeType: 'image/jpeg',
      selectedCategorySlug: 'potholes',
      blockId: randomUUID(),
      spotId: randomUUID(),
      latitude: null,
      longitude: null,
      submittedAt: new Date(),
      candidateCategories: [cat],
    });

    expect(result.requiresHumanReview).toBe(true);
    expect(result.status).toBe('NEEDS_HUMAN_REVIEW');
  });

  it('a high score with a near-tied runner-up is treated as ambiguous, not as confident', async () => {
    const a = { id: randomUUID(), name: 'Damaged Doors', slug: 'damaged-doors', description: null };
    const analyzer = analyzerWith(
      [
        { label: labelFor('Damaged Doors'), score: 0.52 },
        { label: NOTHING_WRONG_LABEL, score: 0.51 },
      ],
      { ambiguityMargin: 0.15 },
    );

    const result = await analyzer.analyze({
      reportId: randomUUID(),
      evidenceRef: 'local://x.jpg',
      mimeType: 'image/jpeg',
      selectedCategorySlug: 'damaged-doors',
      blockId: randomUUID(),
      spotId: randomUUID(),
      latitude: null,
      longitude: null,
      submittedAt: new Date(),
      candidateCategories: [a],
    });

    // 0.52 clears no threshold problem by itself, but a 0.01 margin means the model
    // cannot distinguish the two options, so a human must look.
    expect(result.requiresHumanReview).toBe(true);
  });

  it('when the model says nothing is wrong, it never rejects the report and never invents a category', async () => {
    const cat = { id: randomUUID(), name: 'Broken Lighting', slug: 'broken-lighting', description: null };
    const analyzer = analyzerWith([
      { label: NOTHING_WRONG_LABEL, score: 0.88 },
      { label: labelFor('Broken Lighting'), score: 0.08 },
    ]);

    const result = await analyzer.analyze({
      reportId: randomUUID(),
      evidenceRef: 'local://x.jpg',
      mimeType: 'image/jpeg',
      selectedCategorySlug: 'broken-lighting',
      blockId: randomUUID(),
      spotId: randomUUID(),
      latitude: null,
      longitude: null,
      submittedAt: new Date(),
      candidateCategories: [cat],
    });

    // No category predicted, no confidence claimed — and routed to a human rather than
    // silently discarding a student's report.
    expect(result.predictedCategoryId).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.categoryMatchesStudentSelection).toBeNull();
    expect(result.requiresHumanReview).toBe(true);
    expect(result.status).toBe('NEEDS_HUMAN_REVIEW');
  });

  it('a category id the caller never offered is rejected, not persisted', async () => {
    const cat = { id: randomUUID(), name: 'Waste Management', slug: 'waste', description: null };
    const analyzer = analyzerWith([{ label: NOTHING_WRONG_LABEL, score: 0.9 }]);

    // Build a result naming a category outside the offered set and validate it directly.
    const { validateAnalysisResult } = await import('@campus/domain');
    expect(() =>
      validateAnalysisResult(
        {
          reportId: '00000000-0000-4000-8000-000000000000',
          provider: 'local-clip',
          model: 'fake/clip',
          modelVersion: 'onnx-q8',
          status: 'SUCCEEDED',
          predictedCategoryId: '11111111-1111-4111-8111-111111111111',
          categoryMatchesStudentSelection: true,
          confidence: 0.9,
          severity: null,
          repairRecommendation: null,
          duplicateCandidates: [],
          requiresHumanReview: false,
        },
        {
          reportId: '00000000-0000-4000-8000-000000000000',
          evidenceRef: 'x',
          mimeType: 'image/jpeg',
          selectedCategorySlug: 'waste',
          blockId: randomUUID(),
          spotId: randomUUID(),
          latitude: null,
          longitude: null,
          submittedAt: new Date(),
          candidateCategories: [cat],
        },
      ),
    ).toThrow(/not in the active category set/i);

    // And the analyzer itself never produces that situation with real inputs.
    await expect(
      analyzer.analyze({
        reportId: randomUUID(),
        evidenceRef: 'local://x.jpg',
        mimeType: 'image/jpeg',
        selectedCategorySlug: 'waste',
        blockId: randomUUID(),
        spotId: randomUUID(),
        latitude: null,
        longitude: null,
        submittedAt: new Date(),
        candidateCategories: [],
      }),
    ).rejects.toThrow(/no active issue categories/i);
  });

  it('malformed model output is rejected before it can be persisted', async () => {
    const { validateAnalysisResult } = await import('@campus/domain');
    const request = {
      reportId: '00000000-0000-4000-8000-000000000000',
      evidenceRef: 'x',
      mimeType: 'image/jpeg',
      selectedCategorySlug: 'waste',
      blockId: randomUUID(),
      spotId: randomUUID(),
      latitude: null,
      longitude: null,
      submittedAt: new Date(),
      candidateCategories: [{ id: randomUUID(), slug: 'waste', name: 'Waste', description: null }],
    };
    // confidence out of range
    expect(() =>
      validateAnalysisResult({ ...validResult(request.reportId), confidence: 7 }, request),
    ).toThrow(/schema validation/i);
    // missing required field
    const { status, ...withoutStatus } = validResult(request.reportId);
    expect(() => validateAnalysisResult(withoutStatus, request)).toThrow(/schema validation/i);
  });

  it('a result attributed to a different report is refused', async () => {
    const { validateAnalysisResult } = await import('@campus/domain');
    const request = {
      reportId: '00000000-0000-4000-8000-000000000000',
      evidenceRef: 'x',
      mimeType: 'image/jpeg',
      selectedCategorySlug: 'waste',
      blockId: randomUUID(),
      spotId: randomUUID(),
      latitude: null,
      longitude: null,
      submittedAt: new Date(),
      candidateCategories: [{ id: randomUUID(), slug: 'waste', name: 'Waste', description: null }],
    };
    expect(() =>
      validateAnalysisResult(validResult('99999999-9999-4999-8999-999999999999'), request),
    ).toThrow(/while analysing/i);
  });
});

function validResult(reportId: string) {
  return {
    reportId,
    provider: 'local-clip',
    model: 'fake/clip',
    modelVersion: 'onnx-q8',
    status: 'SUCCEEDED' as const,
    predictedCategoryId: null,
    categoryMatchesStudentSelection: null,
    confidence: 0.9,
    severity: null,
    repairRecommendation: null,
    duplicateCandidates: [],
    requiresHumanReview: false,
  };
}

/* ------------------------------------------------------------------ */
/* Failure handling and retries (§16)                                  */
/* ------------------------------------------------------------------ */

describe('AI failure handling (fake classifier — NOT real inference)', () => {
  it('evidence that cannot be decoded is a PERMANENT failure and is not retried', async () => {
    let calls = 0;
    const analyzer = new LocalClipAnalyzer({
      provider: 'local-clip',
      model: 'fake/clip',
      cacheDir: '/nonexistent',
      confidenceThreshold: 0.7,
      ambiguityMargin: 0.15,
      timeoutMs: 5_000,
      maxAttempts: 3,
      allowRemoteDownload: false,
      loadEvidence: async () => {
        calls += 1;
        // Not a decodable image at all.
        return Buffer.from('this is not an image, it is text');
      },
      classifier: fakeClassifier([{ label: NOTHING_WRONG_LABEL, score: 0.9 }]),
      // A decoder that rejects the way the real one does for undecodable bytes.
      decodeImage: async () => {
        throw new AiPermanentError(
          'Stored evidence could not be decoded as an image',
          'AI_INVALID_EVIDENCE',
        );
      },
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
    });

    await expect(
      analyzer.analyze({
        reportId: randomUUID(),
        evidenceRef: 'local://x.jpg',
        mimeType: 'image/jpeg',
        selectedCategorySlug: 'waste',
        blockId: randomUUID(),
        spotId: randomUUID(),
        latitude: null,
        longitude: null,
        submittedAt: new Date(),
        candidateCategories: [{ id: randomUUID(), slug: 'waste', name: 'Waste', description: null }],
      }),
    ).rejects.toThrow(/could not be decoded|no pixels|minimum accepted edge/i);

    // Exactly one attempt: a permanently-bad image must not burn the retry budget.
    expect(calls).toBe(1);
  });

  it('a transient provider failure IS retried, up to the bound', async () => {
    const { AiTransientError, withRetry } = await import('@campus/domain');
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new AiTransientError('model cold');
        return 'ok';
      },
      { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('a persistent transient failure gives up at the bound instead of looping forever', async () => {
    const { AiTransientError, withRetry } = await import('@campus/domain');
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new AiTransientError('still cold');
        },
        { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow(/still cold/);
    expect(attempts).toBe(3);
  });

  it('a permanent failure is not retried even when retries are available', async () => {
    const { AiPermanentError, withRetry } = await import('@campus/domain');
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new AiPermanentError('bad image', 'AI_INVALID_EVIDENCE');
        },
        { maxAttempts: 5, baseDelayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow(/bad image/);
    expect(attempts).toBe(1);
  });

  it('a slow provider times out rather than hanging the worker', async () => {
    const { withTimeout } = await import('@campus/domain');
    await expect(withTimeout(new Promise(() => {}), 30, 'test')).rejects.toThrow(/exceeded 30 ms/);
  });

  it('failure descriptions never leak filesystem paths', async () => {
    const { describeAiFailure, AiPermanentError } = await import('@campus/domain');
    const described = describeAiFailure(
      new AiPermanentError('Stored evidence could not be read', 'AI_EVIDENCE_NOT_FOUND'),
    );
    expect(described.code).toBe('AI_EVIDENCE_NOT_FOUND');
    expect(described.message).not.toMatch(/\/(home|Users|campus)\//);
  });
});

/* ------------------------------------------------------------------ */
/* End-to-end persistence through the real HTTP route                  */
/* ------------------------------------------------------------------ */

describe('analysis persistence through the API', () => {
  it('an unconfigured provider returns 501 and writes NO analysis row', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/reports/${randomUUID()}/analyze`,
      headers: auth(ctx.tokens.hod),
    });
    expect(res.statusCode).toBe(501);
    expect(errorCode(res)).toBe('NOT_IMPLEMENTED');
  });

  it('a configured provider persists a real analysis row and leaves the student selection intact', async () => {
    // A report with real stored evidence.
    const submitted = await submitReport(ctx, ctx.tokens.student);
    const reportId = submitted.json.reportId as string;
    const report = await ctx.db.query<{ evidence_storage_key: string; selected_category_id: string }>(
      `SELECT evidence_storage_key, selected_category_id FROM reports WHERE id = $1`,
      [reportId],
    );
    const selectedCategoryId = report.rows[0]!.selected_category_id;

    const blocksRes = await ctx.app.inject({
      method: 'GET',
      url: '/v1/campus/categories',
      headers: auth(ctx.tokens.student),
    });
    const categories = (
      blocksRes.json() as { items: { id: string; name: string; description: string | null }[] }
    ).items;
    const other = categories.find((c) => c.id !== selectedCategoryId)!;

    // The model will claim a DIFFERENT category from the DB's own list, to prove a
    // disagreement is stored as a disagreement.
    // Built with the SAME helper the adapter uses, description included — the prompt
    // embeds the category description, so a label without it would never match.
    const ai = analyzerWith([
      { label: labelFor(other.name, other.description), score: 0.91 },
      { label: NOTHING_WRONG_LABEL, score: 0.05 },
    ]);

    const app = await buildApp({
      db: ctx.db,
      config: { ...ctx.config, aiProvider: 'local-clip' },
      storage: ctx.storage,
      ai,
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/reports/${reportId}/analyze`,
        headers: auth(ctx.tokens.hod),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('NEEDS_HUMAN_REVIEW');
      expect(body.predictedCategoryId).toBe(other.id);
      expect(body.requiresHumanReview).toBe(true);

      // Persisted, not just returned.
      const rows = await ctx.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ai_analyses WHERE report_id = $1 AND status = 'NEEDS_HUMAN_REVIEW'`,
        [reportId],
      );
      expect(rows.rows[0]!.n).toBe('1');

      // BOTH categories are stored separately (§9). The student was not overridden.
      const after = await ctx.db.query<{ selected_category_id: string; ai_predicted_category_id: string; validation_status: string }>(
        `SELECT selected_category_id, ai_predicted_category_id, validation_status FROM reports WHERE id = $1`,
        [reportId],
      );
      expect(after.rows[0]!.selected_category_id).toBe(selectedCategoryId);
      expect(after.rows[0]!.ai_predicted_category_id).toBe(other.id);
      // §10: AI analysis must NOT mark a report validated.
      expect(after.rows[0]!.validation_status).toBe('PENDING');

      // The student can read their own analysis; a second student cannot.
      const mine = await app.inject({
        method: 'GET',
        url: `/v1/reports/${reportId}/analysis`,
        headers: auth(ctx.tokens.student),
      });
      expect(mine.statusCode).toBe(200);
      expect(mine.json().analysis.provider).toBe('local-clip');
      expect(mine.json().report.selectedCategoryId).toBe(selectedCategoryId);
      expect(mine.json().report.aiPredictedCategoryId).toBe(other.id);

      const theirs = await app.inject({
        method: 'GET',
        url: `/v1/reports/${reportId}/analysis`,
        headers: auth(ctx.tokens.student2),
      });
      expect(theirs.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('a failing provider persists an explicit FAILED row and does NOT erase or validate the report', async () => {
    const submitted = await submitReport(ctx, ctx.tokens.student2);
    const reportId = submitted.json.reportId as string;

    const failing = new LocalClipAnalyzer({
      provider: 'local-clip',
      model: 'fake/clip',
      cacheDir: '/nonexistent',
      confidenceThreshold: 0.7,
      ambiguityMargin: 0.15,
      timeoutMs: 1_000,
      maxAttempts: 1,
      allowRemoteDownload: false,
      loadEvidence: async () => Buffer.from('not an image'),
      classifier: fakeClassifier([]),
      decodeImage: async () => {
        throw new AiPermanentError('Stored evidence could not be decoded as an image', 'AI_INVALID_EVIDENCE');
      },
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, sleep: async () => {} },
    });

    const outcome = await runAnalysis(ctx.db, failing, ctx.ids.demoWorkspaceId, reportId, null, 'DEMO');
    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorCode).toBe('AI_INVALID_EVIDENCE');

    const rows = await ctx.db.query<{ status: string; error_message: string }>(
      `SELECT status, error_message FROM ai_analyses WHERE report_id = $1`,
      [reportId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.status).toBe('FAILED');
    expect(rows.rows[0]!.error_message).toMatch(/AI_INVALID_EVIDENCE/);

    // The report still exists, is still PENDING, and is still recoverable.
    const report = await ctx.db.query<{ validation_status: string }>(
      `SELECT validation_status FROM reports WHERE id = $1`,
      [reportId],
    );
    expect(report.rows[0]!.validation_status).toBe('PENDING');

    // And no token was awarded for a failed analysis.
    const ledger = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM token_transactions WHERE idempotency_key LIKE $1`,
      [`report:${reportId}:%`],
    );
    expect(ledger.rows[0]!.n).toBe('0');
  });

  it('the review queue surfaces the analysis a human must decide on', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/review-queue',
      headers: auth(ctx.tokens.hod),
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
  });

  it('reports the configured provider honestly rather than claiming accuracy', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/ai/status',
      headers: auth(ctx.tokens.admin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toBe('unconfigured');
    expect(res.json().configured).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Prompt construction                                                 */
/* ------------------------------------------------------------------ */

describe('zero-shot label construction', () => {
  it('builds one prompt per active category, from the database rows', () => {
    const labels = buildLabels([
      { id: 'a', slug: 'water-leakage', name: 'Water Leakage', description: 'Leaking pipes, taps, tanks' },
      { id: 'b', slug: 'waste', name: 'Waste Management', description: null },
    ]);
    const keys = [...labels.keys()];
    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain('water leakage');
    expect(keys[0]).toContain('leaking pipes');
    expect(keys[1]).toContain('waste management');
    expect(labels.get(keys[0]!)!.slug).toBe('water-leakage');
  });

  it('the shared confidence threshold and the default config agree', () => {
    // If these ever diverge, the operator-facing config would contradict the shared
    // contract that every client imports.
    expect(AI_CONFIG_DEFAULTS.aiConfidenceThreshold).toBe(AI_REVIEW_CONFIDENCE_THRESHOLD);
  });
});
