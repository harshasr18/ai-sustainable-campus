/**
 * AI analysis routes (§17) — rebuilt in Phase 2.
 *
 * WHY THIS FILE EXISTS RATHER THAN AN EDIT TO integrations.ts:
 * the Phase 1 `/v1/reports/:id/analyze` endpoint was a contract stub. It called the
 * analyzer with `evidenceRef: '', mimeType: '', blockId: '', spotId: ''` — every input
 * an empty string — because no adapter could run. Swapping in a real model without
 * rebuilding that route would have run inference on NO IMAGE and then persisted a
 * result. (Recorded as risk R1 in docs/PHASE2_AUDIT.md.) The route is therefore
 * rewritten to actually load the report, authorize the caller, resolve the stored
 * evidence and supply the ACTIVE category set.
 *
 * WHAT THE AI LAYER IS ALLOWED TO DO HERE: produce an analysis, and persist it.
 * It never approves an issue, never merges a duplicate and never awards a token. Those
 * remain human and ledger operations, reached through different code paths.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AI_REVIEW_CONFIDENCE_THRESHOLD, type AiAnalysisResult } from '@campus/contracts';
import {
  canReadEvidence,
  describeAiFailure,
  forbidden,
  notFound,
  notImplemented,
  validationFailed,
  type AiAnalysisRequest,
  type AiAnalyzer,
  type CandidateCategory,
} from '@campus/domain';
import {
  aiAnalyses as analysisRepo,
  audit as auditRepo,
  campus as campusRepo,
  reports as reportRepo,
  type AiAnalysisRow,
  type Db,
} from '@campus/db';
import { actorOf, requireAuth } from '../auth-plugin.js';
import { outboxPublisher } from '@campus/domain';

const IdParamsSchema = z.object({ id: z.uuid() });

export function registerAnalysisRoutes(
  app: FastifyInstance,
  deps: { db: Db; ai: AiAnalyzer },
): void {
  const { db, ai } = deps;

  /* ---------------------------------------------------------------- */
  /* POST /v1/reports/:id/analyze — run analysis on demand             */
  /* ---------------------------------------------------------------- */
  /**
   * HOD/ADMIN only. The background worker calls the same pipeline function directly;
   * this endpoint exists so an authorized operator can retry a failed analysis without
   * waiting for a poll — the §16 requirement that failures stay recoverable.
   */
  app.post(
    '/v1/reports/:id/analyze',
    {
      preHandler: requireAuth(db, 'HOD', 'ADMIN'),
      schema: { params: IdParamsSchema },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IdParamsSchema>;

      const outcome = await runAnalysis(db, ai, actor.workspaceId, id, actor.userId, actor.workspaceKind);
      return outcome;
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /v1/reports/:id/analysis — retrieve the authorized result     */
  /* ---------------------------------------------------------------- */
  /**
   * Students see their OWN report's analysis; HOD/ADMIN see any in their workspace.
   * The database scopes by workspace, `canReadEvidence` scopes by owner (§18).
   */
  app.get(
    '/v1/reports/:id/analysis',
    { preHandler: requireAuth(db), schema: { params: IdParamsSchema } },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IdParamsSchema>;

      const report = await reportRepo.findById(db, actor.workspaceId, id);
      if (!report) throw notFound('Report not found.');
      if (!canReadEvidence(actor, report)) throw forbidden('You can only view your own reports.');

      const latest = await analysisRepo.latestForReport(db, actor.workspaceId, id);
      return {
        reportId: id,
        validationStatus: report.validation_status,
        duplicateMatchStatus: report.duplicate_match_status,
        // The report's own denormalized AI columns — what the workflow actually uses.
        report: serializeReportAi(report),
        // The full analysis record, including model identity and attempt history.
        analysis: latest ? serializeAnalysis(latest) : null,
        humanReviewConfidenceThreshold: AI_REVIEW_CONFIDENCE_THRESHOLD,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /v1/admin/review-queue — what a human needs to look at        */
  /* ---------------------------------------------------------------- */
  app.get(
    '/v1/admin/review-queue',
    {
      preHandler: requireAuth(db, 'HOD', 'ADMIN'),
      schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    },
    async (request) => {
      const actor = actorOf(request);
      const { limit } = request.query as { limit: number };
      const items = await analysisRepo.listNeedingReview(db, actor.workspaceId, limit);
      return {
        count: items.length,
        items: items.map((row) => ({
          analysisId: row.id,
          reportId: row.report_id,
          issueId: row.issue_id,
          status: row.status,
          predictedCategoryId: row.predicted_category_id,
          selectedCategoryId: row.selected_category_id,
          confidence: row.confidence,
          categoryMatchesChoice: row.category_matches_choice,
          duplicateCandidates: row.duplicate_candidates,
          createdAt: new Date(row.created_at).toISOString(),
        })),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /v1/admin/ai/status — what model is actually configured       */
  /* ---------------------------------------------------------------- */
  /**
   * Deliberately reports the CONFIGURED provider, not a claim of accuracy. An operator
   * must be able to answer "is AI running here, and which model?" without reading code.
   */
  app.get('/v1/admin/ai/status', { preHandler: requireAuth(db, 'ADMIN') }, async () => ({
    provider: ai.provider,
    model: ai.model,
    modelVersion: ai.modelVersion,
    configured: ai.provider !== 'unconfigured',
    humanReviewConfidenceThreshold: AI_REVIEW_CONFIDENCE_THRESHOLD,
    severitySource: 'NOT_IMPLEMENTED_STAGE_6',
  }));
}

/* ------------------------------------------------------------------ */
/* The pipeline entry point (shared by the route and the worker)       */
/* ------------------------------------------------------------------ */

export interface RunAnalysisResult {
  reportId: string;
  status: AiAnalysisResult['status'] | 'FAILED';
  provider: string;
  model: string;
  predictedCategoryId: string | null;
  confidence: number | null;
  requiresHumanReview: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number;
  attempts: number;
}

/**
 * Runs analysis for one report and persists the outcome.
 *
 * FAILURE IS A FIRST-CLASS OUTCOME, NOT AN EXCEPTION THAT VANISHES: a failed analysis
 * writes a `FAILED` row with a machine-readable code, leaves `validation_status` alone
 * (still PENDING, so the report remains queued and recoverable) and never touches the
 * token ledger. §16 and §10 both require this: "A failed AI request must not erase a
 * report or falsely mark it as validated."
 */
export async function runAnalysis(
  db: Db,
  ai: AiAnalyzer,
  workspaceId: string,
  reportId: string,
  actorUserId: string | null,
  /**
   * The workspace KIND carried in the published event envelope. Passed in rather than
   * inferred, because a DEMO workspace's events must never be labelled REAL — demo and
   * real data are never mixed (Phase 1 §18), and the event envelope is data.
   */
  workspaceKind: 'REAL' | 'DEMO' = 'REAL',
): Promise<RunAnalysisResult> {
  // An UNCONFIGURED provider is not a failed analysis — it is an absent one. Keeping
  // these distinct preserves the honest 501 boundary from Phase 1: an operator must be
  // able to tell "AI is switched off here" apart from "the model crashed".
  if (ai.provider === 'unconfigured') {
    throw notImplemented(
      'AI analysis is not configured. Set AI_PROVIDER=local-clip to enable the local ' +
        'vision model (see docs/AI_MODEL.md).',
    );
  }

  const report = await reportRepo.findById(db, workspaceId, reportId);
  if (!report) throw notFound('Report not found in your campus.');
  if (!report.evidence_storage_key) {
    throw validationFailed('This report has no stored photograph, so it cannot be analysed.');
  }

  // The active category set drives the classification. Read fresh each run so a
  // category added or deactivated takes effect without a restart or a retrain.
  const categories = await campusRepo.listCategories(db);
  const candidateCategories: CandidateCategory[] = categories.map((c) => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description,
  }));
  const selected = categories.find((c) => c.id === report.selected_category_id);

  const analysisRequest: AiAnalysisRequest = {
    reportId,
    evidenceRef: report.evidence_storage_key,
    mimeType: 'image/jpeg',
    selectedCategorySlug: selected?.slug ?? '',
    blockId: report.block_id,
    spotId: report.spot_id,
    latitude: report.latitude,
    longitude: report.longitude,
    submittedAt: new Date(report.submitted_at),
    candidateCategories,
  };

  const startedAt = Date.now();
  try {
    const result = await ai.analyze(analysisRequest);
    const latencyMs = Date.now() - startedAt;

    await persistSuccess(db, {
      workspaceId,
      reportId,
      result,
      latencyMs,
      actorUserId,
      selectedCategoryId: report.selected_category_id,
      workspaceKind,
    });

    return {
      reportId,
      status: result.status,
      provider: result.provider,
      model: result.model,
      predictedCategoryId: result.predictedCategoryId,
      confidence: result.confidence,
      requiresHumanReview: result.requiresHumanReview,
      errorCode: null,
      errorMessage: null,
      latencyMs,
      attempts: 1,
    };
  } catch (error) {
    const failure = describeAiFailure(error);
    const latencyMs = Date.now() - startedAt;

    await persistFailure(db, {
      workspaceId,
      reportId,
      provider: ai.provider,
      model: ai.model,
      modelVersion: ai.modelVersion,
      errorCode: failure.code,
      errorMessage: failure.message,
      latencyMs,
      actorUserId,
      workspaceKind,
    });

    return {
      reportId,
      status: 'FAILED',
      provider: ai.provider,
      model: ai.model,
      predictedCategoryId: null,
      confidence: null,
      requiresHumanReview: true,
      errorCode: failure.code,
      errorMessage: failure.message,
      latencyMs,
      attempts: 1,
    };
  }
}

/**
 * Persists a SUCCEEDED / NEEDS_HUMAN_REVIEW analysis.
 *
 * One transaction: the analysis row, the report's denormalized AI columns, the audit
 * row and the outbox event all commit together or not at all. §17: "Publish events
 * only after the relevant database transaction commits" — structurally guaranteed
 * here, because the event is written INSIDE that transaction.
 */
async function persistSuccess(
  db: Db,
  input: {
    workspaceId: string;
    reportId: string;
    result: AiAnalysisResult;
    latencyMs: number;
    actorUserId: string | null;
    selectedCategoryId: string;
    workspaceKind: 'REAL' | 'DEMO';
  },
): Promise<void> {
  await db.withTransaction(async (tx) => {
    const { result } = input;

    await analysisRepo.insert(tx, {
      workspaceId: input.workspaceId,
      reportId: input.reportId,
      provider: result.provider,
      model: result.model,
      modelVersion: result.modelVersion,
      status: result.status,
      predictedCategoryId: result.predictedCategoryId,
      categoryMatchesChoice: result.categoryMatchesStudentSelection,
      confidence: result.confidence,
      severity: result.severity,
      repairRecommendation: result.repairRecommendation,
      duplicateCandidates: result.duplicateCandidates,
      requiresHumanReview: result.requiresHumanReview,
      errorMessage: null,
      latencyMs: input.latencyMs,
    });

    // The report keeps BOTH: the student's original selection is never overwritten
    // (§7, §9), and the prediction is stored beside it.
    await reportRepo.applyAiFindings(tx, input.workspaceId, input.reportId, {
      aiPredictedCategoryId: result.predictedCategoryId,
      aiConfidence: result.confidence,
      aiSeverity: result.severity,
      repairRecommendation: result.repairRecommendation,
    });

    await auditRepo.record(tx, {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: 'report.ai_analyzed',
      entityType: 'REPORT',
      entityId: input.reportId,
      before: { aiPredictedCategoryId: null },
      after: {
        aiPredictedCategoryId: result.predictedCategoryId,
        confidence: result.confidence,
        status: result.status,
        model: result.model,
      },
      reason: `model ${result.provider}/${result.model}@${result.modelVersion}`,
    });

    await outboxPublisher.publish(tx, {
      eventType: 'report.analysis_completed',
      workspaceId: input.workspaceId,
      workspace: input.workspaceKind,
      entityType: 'REPORT',
      entityId: input.reportId,
      entityVersion: 1,
      actorUserId: input.actorUserId,
      payload: {
        reportId: input.reportId,
        status: result.status,
        predictedCategoryId: result.predictedCategoryId,
        confidence: result.confidence,
        requiresHumanReview: result.requiresHumanReview,
        duplicateCandidateCount: result.duplicateCandidates.length,
        model: result.model,
      },
    });

    if (result.requiresHumanReview) {
      await outboxPublisher.publish(tx, {
        eventType: 'report.review_required',
        workspaceId: input.workspaceId,
        workspace: input.workspaceKind,
        entityType: 'REPORT',
        entityId: input.reportId,
        entityVersion: 1,
        actorUserId: input.actorUserId,
        payload: {
          reportId: input.reportId,
          reason: result.categoryMatchesStudentSelection === false ? 'CATEGORY_DISAGREEMENT' : 'LOW_CONFIDENCE',
          confidence: result.confidence,
        },
      });
    }
  });
}

/** Persists an explicit, dated failure. Deliberately does NOT touch validation_status. */
async function persistFailure(
  db: Db,
  input: {
    workspaceId: string;
    reportId: string;
    provider: string;
    model: string;
    modelVersion: string;
    errorCode: string;
    errorMessage: string;
    latencyMs: number;
    actorUserId: string | null;
    workspaceKind: 'REAL' | 'DEMO';
  },
): Promise<void> {
  await db.withTransaction(async (tx) => {
    await analysisRepo.insert(tx, {
      workspaceId: input.workspaceId,
      reportId: input.reportId,
      provider: input.provider,
      model: input.model,
      modelVersion: input.modelVersion,
      status: 'FAILED',
      predictedCategoryId: null,
      categoryMatchesChoice: null,
      confidence: null,
      severity: null,
      repairRecommendation: null,
      duplicateCandidates: [],
      requiresHumanReview: true,
      errorMessage: `${input.errorCode}: ${input.errorMessage}`.slice(0, 1000),
      latencyMs: input.latencyMs,
    });

    await outboxPublisher.publish(tx, {
      eventType: 'report.analysis_failed',
      workspaceId: input.workspaceId,
      workspace: input.workspaceKind,
      entityType: 'REPORT',
      entityId: input.reportId,
      entityVersion: 1,
      actorUserId: input.actorUserId,
      payload: {
        reportId: input.reportId,
        errorCode: input.errorCode,
        recoverable: true,
      },
    });
  });
}

function serializeReportAi(r: {
  selected_category_id: string;
  ai_predicted_category_id: string | null;
  ai_confidence: number | null;
  ai_severity: string | null;
  repair_recommendation: string | null;
}) {
  return {
    // Both are returned, side by side, so a client can never confuse them.
    selectedCategoryId: r.selected_category_id,
    aiPredictedCategoryId: r.ai_predicted_category_id,
    aiConfidence: r.ai_confidence,
    aiSeverity: r.ai_severity,
    repairRecommendation: r.repair_recommendation,
  };
}

function serializeAnalysis(row: AiAnalysisRow) {
  return {
    id: row.id,
    reportId: row.report_id,
    provider: row.provider,
    model: row.model,
    modelVersion: row.model_version,
    status: row.status,
    predictedCategoryId: row.predicted_category_id,
    categoryMatchesChoice: row.category_matches_choice,
    confidence: row.confidence,
    severity: row.severity,
    repairRecommendation: row.repair_recommendation,
    duplicateCandidates: row.duplicate_candidates,
    requiresHumanReview: row.requires_human_review,
    errorMessage: row.error_message,
    latencyMs: row.latency_ms,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}
