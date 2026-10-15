/**
 * Student report submission and retrieval.
 *
 * The photo is REQUIRED and arrives in the same multipart request as the fields, so
 * a report can never exist without evidence. The route layer does only three things:
 * parse, validate, delegate. All business rules live in the domain service.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateReportRequestSchema, TOKEN_POLICY, tokenCreditIdempotencyKey } from '@campus/contracts';
import {
  canReadEvidence,
  forbidden,
  notFound,
  recordValidationOutcome,
  submitReport,
  validationFailed,
  type EvidenceStorage,
} from '@campus/domain';
import { reports as reportRepo, tokens as tokenRepo, type Db, type ReportRow } from '@campus/db';
import { actorOf, requireAuth } from '../auth-plugin.js';

const IdParamsSchema = z.object({ id: z.uuid() });

/**
 * Query fields arrive as strings in a multipart form, so numbers and dates are
 * coerced explicitly and validated by the SAME contract schema the clients import.
 */
const ReportFieldsSchema = CreateReportRequestSchema.extend({
  blockId: z.uuid('blockId must be a UUID'),
  spotId: z.uuid('spotId must be a UUID'),
  selectedCategoryId: z.uuid('selectedCategoryId must be a UUID'),
  latitude: z.coerce.number().gte(-90).lte(90).optional(),
  longitude: z.coerce.number().gte(-180).lte(180).optional(),
  capturedAt: z.string().datetime({ offset: true }).optional(),
});

const ValidationOutcomeSchema = z.object({
  validationStatus: z.enum(['AI_VALIDATED', 'HUMAN_VALIDATED', 'DUPLICATE_VALIDATED', 'REJECTED']),
  duplicateMatchStatus: z.enum(['NO_MATCH', 'LINKED', 'CANDIDATE_FOUND', 'HUMAN_OVERRIDDEN']).optional(),
  aiPredictedCategoryId: z.uuid().nullable().optional(),
  aiConfidence: z.number().min(0).max(1).nullable().optional(),
  aiSeverity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).nullable().optional(),
  repairRecommendation: z.string().max(2000).nullable().optional(),
  reason: z.string().max(500).optional(),
});

export function registerReportRoutes(
  app: FastifyInstance,
  deps: { db: Db; storage: EvidenceStorage; maxEvidenceBytes: number },
): void {
  const { db, storage } = deps;

  /* ---------------------------------------------------------------- */
  /* POST /v1/reports — create a report with its photo                */
  /* ---------------------------------------------------------------- */
  app.post('/v1/reports', { preHandler: requireAuth(db, 'STUDENT', 'HOD', 'ADMIN') }, async (request) => {
    const actor = actorOf(request);

    if (!request.isMultipart()) {
      throw validationFailed('A photograph is required. Submit this endpoint as multipart/form-data with a "photo" file field.');
    }

    const fields: Record<string, string> = {};
    let photo: { buffer: Buffer; mimeType: string } | null = null;

    // Bounded parse: @fastify/multipart is configured with fileSize/files/fields limits
    // in app.ts, so an oversized or multi-file upload is rejected before this loop.
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'photo') {
          // Drain and ignore unexpected files rather than buffering them.
          await part.toBuffer();
          continue;
        }
        if (photo) throw validationFailed('Only one photograph may be submitted per report.');
        photo = { buffer: await part.toBuffer(), mimeType: part.mimetype };
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }

    if (!photo) {
      throw validationFailed('A photograph is required. Gallery uploads are not accepted for reporting; use the in-app camera.');
    }

    // Validate before writing anything to storage.
    const parsed = ReportFieldsSchema.safeParse({
      ...fields,
      // reportingContext may arrive as a JSON string field
      reportingContext:
        typeof fields.reportingContext === 'string' && fields.reportingContext.length > 0
          ? safeJsonParse(fields.reportingContext)
          : undefined,
    });
    if (!parsed.success) {
      throw validationFailed(
        'The report details are invalid.',
        parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
      );
    }

    // Validate + store the photo BEFORE the DB transaction (keeps locks short).
    const stored = await storage.save({
      buffer: photo.buffer,
      declaredMimeType: photo.mimeType,
      workspaceId: actor.workspaceId,
    });

    const result = await submitReport(db, actor, {
      blockId: parsed.data.blockId,
      spotId: parsed.data.spotId,
      selectedCategoryId: parsed.data.selectedCategoryId,
      title: parsed.data.title,
      description: parsed.data.description,
      capturedAt: parsed.data.capturedAt,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      reportingContext: parsed.data.reportingContext,
      evidenceStorageKey: stored.key,
    });

    request.log.info(
      { reportId: result.reportId, issueId: result.issueId, duplicate: !result.createdNewIssue },
      'report submitted',
    );

    return {
      reportId: result.reportId,
      issueId: result.issueId,
      issuePublicReference: result.issuePublicReference,
      duplicateOfExistingIssue: !result.createdNewIssue,
      duplicateMatchStatus: result.duplicateMatchStatus,
      // Explicit: tokens are NOT awarded at submission time. A trusted server-side
      // validation step must run first (brief Step C).
      tokensAwarded: 0,
      tokenPolicy: { tokensPerValidatedReport: TOKEN_POLICY.TOKENS_PER_VALIDATED_REPORT },
      validationStatus: 'PENDING',
    };
  });

  /* ---------------------------------------------------------------- */
  /* GET /v1/reports/mine — the student's own history                 */
  /* ---------------------------------------------------------------- */
  app.get(
    '/v1/reports/mine',
    {
      preHandler: requireAuth(db),
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(25),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = request.query as { limit: number; offset: number };
      const { items, total } = await reportRepo.listForReporter(db, actor.workspaceId, actor.userId, q.limit, q.offset);

      // Which of the caller's reports have earned tokens — read from the ledger.
      const enriched = await Promise.all(
        items.map(async (row) => ({
          id: row.id,
          issueId: row.issue_id,
          validationStatus: row.validation_status,
          duplicateMatchStatus: row.duplicate_match_status,
          blockId: row.block_id,
          spotId: row.spot_id,
          selectedCategoryId: row.selected_category_id,
          capturedAt: row.captured_at ? new Date(row.captured_at).toISOString() : null,
          submittedAt: new Date(row.submitted_at).toISOString(),
          hasEvidence: Boolean(row.evidence_storage_key),
          evidenceUrl: row.evidence_storage_key ? `/v1/reports/${row.id}/evidence` : null,
          tokensAwarded: (await tokenRepo.latestCreditForReport(db, actor.workspaceId, row.id))?.amount ?? 0,
        })),
      );

      return { items: enriched, total, limit: q.limit, offset: q.offset };
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /v1/reports/:id                                              */
  /* ---------------------------------------------------------------- */
  app.get(
    '/v1/reports/:id',
    { preHandler: requireAuth(db), schema: { params: IdParamsSchema } },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IdParamsSchema>;
      const report = await reportRepo.findById(db, actor.workspaceId, id);
      if (!report) throw notFound('Report not found.');
      // Students may only read their own reports; HOD/ADMIN may read any in their workspace.
      if (!canReadEvidence(actor, report)) throw forbidden('You can only view your own reports.');
      return { report: serializeReport(report) };
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /v1/reports/:id/evidence — private photo, authorization gated */
  /* ---------------------------------------------------------------- */
  app.get(
    '/v1/reports/:id/evidence',
    { preHandler: requireAuth(db), schema: { params: IdParamsSchema } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IdParamsSchema>;

      const report = await reportRepo.findById(db, actor.workspaceId, id);
      if (!report) throw notFound('Report not found.');

      // Brief: "A user cannot retrieve another user's private photo without authorization."
      if (!canReadEvidence(actor, report)) {
        request.log.warn({ actorUserId: actor.userId, reportId: id }, 'evidence access denied');
        throw forbidden('You are not authorized to view this photograph.');
      }
      if (!report.evidence_storage_key) throw notFound('No photograph has been stored for this report.');

      const bytes = await storage.read(report.evidence_storage_key);
      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(bytes);
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /v1/reports/:id/validation — the trusted validation seam     */
  /* ---------------------------------------------------------------- */
  /**
   * Records the server-side verdict on a report and awards tokens when eligible.
   *
   * This is the SAME function the Phase 2 AI worker will call. Staff (HOD/ADMIN) can
   * call it over HTTP today; the AI pipeline will call it in-process. Tokens are
   * decided here — never by a client, and never at submission time.
   *
   * Idempotent: repeating the same outcome for the same report does not re-award.
   */
  app.post(
    '/v1/reports/:id/validation',
    {
      preHandler: requireAuth(db, 'HOD', 'ADMIN'),
      schema: { params: IdParamsSchema, body: ValidationOutcomeSchema },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as z.infer<typeof IdParamsSchema>;
      const body = request.body as z.infer<typeof ValidationOutcomeSchema>;

      const outcome = await recordValidationOutcome(db, actor, { reportId: id, ...body });

      return {
        reportId: outcome.reportId,
        tokenEligible: outcome.tokenEligible,
        tokensAwarded: outcome.tokensAwarded,
        alreadyAwarded: outcome.alreadyAwarded,
        idempotencyKey: outcome.tokenEligible ? tokenCreditIdempotencyKey(id) : null,
      };
    },
  );
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Single serialization path for a report row -> API DTO. */
function serializeReport(r: ReportRow) {
  return {
    id: r.id,
    issueId: r.issue_id,
    reporterUserId: r.reporter_user_id,
    selectedCategoryId: r.selected_category_id,
    aiPredictedCategoryId: r.ai_predicted_category_id,
    aiConfidence: r.ai_confidence,
    aiSeverity: r.ai_severity,
    repairRecommendation: r.repair_recommendation,
    validationStatus: r.validation_status,
    duplicateMatchStatus: r.duplicate_match_status,
    blockId: r.block_id,
    spotId: r.spot_id,
    latitude: r.latitude,
    longitude: r.longitude,
    capturedAt: r.captured_at ? new Date(r.captured_at).toISOString() : null,
    submittedAt: new Date(r.submitted_at).toISOString(),
    hasEvidence: Boolean(r.evidence_storage_key),
    evidenceUrl: r.evidence_storage_key ? `/v1/reports/${r.id}/evidence` : null,
  };
}
