/**
 * AI provider boundary.
 *
 * Phase 1 declared this interface and shipped an implementation that FAILS LOUDLY.
 * Phase 2 (Stage 2/3) keeps the boundary and adds real implementations behind it.
 *
 * THE RULE THAT DOES NOT CHANGE: this layer produces an ANALYSIS. It never approves
 * an issue, never merges a duplicate, never touches a token balance and never sees
 * a role. §5 is explicit, and the way that is enforced here is structural — the
 * adapter is not given the database, the ledger, or the permission system. Its only
 * capabilities are "read these bytes" and "return a validated result".
 */
import {
  AI_REVIEW_CONFIDENCE_THRESHOLD,
  AiAnalysisResultSchema,
  type AiAnalysisResult,
  type Severity,
} from '@campus/contracts';
import { notImplemented } from '../errors.js';
import { AiMalformedOutputError, AiPermanentError } from './ai-errors.js';

/** One row of the active category set, read from the database by the caller. */
export interface CandidateCategory {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

export interface AiAnalysisRequest {
  reportId: string;
  /** Opaque reference resolved by the storage adapter — never a public URL. */
  evidenceRef: string;
  mimeType: string;
  /** What the student said, so the model can be asked to confirm or contradict it. */
  selectedCategorySlug: string;
  blockId: string;
  spotId: string;
  latitude: number | null;
  longitude: number | null;
  submittedAt: Date;
  /**
   * The ACTIVE categories, supplied by the caller from the database.
   *
   * This is why categories stay configurable data: the model is asked about whatever
   * categories exist at the moment of analysis, so adding a category is a data change,
   * not a retraining or a code change. It also lets the adapter refuse to return a
   * category id that is not in this set (guards risk R6 — a model cannot invent,
   * or be tricked into naming, a category that is not currently active).
   */
  candidateCategories: CandidateCategory[];
}

export interface AiAnalyzer {
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  /** Throws on failure — callers must persist an explicit FAILED analysis. */
  analyze(request: AiAnalysisRequest): Promise<AiAnalysisResult>;
  /** Warm the model so the first student report is not the one that pays for loading. */
  warmup?(): Promise<void>;
}

export interface AiAnalyzerConfig {
  provider: 'unconfigured' | 'local-clip' | (string & {});
  model: string;
  cacheDir: string;
  /** Softmax score below which the result MUST go to a human. */
  confidenceThreshold: number;
  /** Top-1 minus top-2 below which the result is considered ambiguous. */
  ambiguityMargin: number;
  timeoutMs: number;
  maxAttempts: number;
  /** False for an air-gapped demo where weights were pre-downloaded. */
  allowRemoteDownload: boolean;
}

/**
 * Default adapter. Every method throws NOT_IMPLEMENTED (HTTP 501), which remains the
 * honest state whenever no provider is configured.
 *
 * This is still the DEFAULT, deliberately: a system that silently ran a real model
 * the moment one was on disk would make "is AI configured here?" unknowable from
 * outside. `AI_PROVIDER` must say so explicitly.
 */
export class UnconfiguredAiAnalyzer implements AiAnalyzer {
  readonly provider = 'unconfigured';
  readonly model = 'none';
  readonly modelVersion = '0';

  async analyze(_request?: AiAnalysisRequest): Promise<AiAnalysisResult> {
    // Deliberately ignores its argument: it has no model to run, and inventing a
    // prediction would be worse than failing.
    throw notImplemented(
      'AI analysis is not configured. Set AI_PROVIDER=local-clip to enable the ' +
        'local vision model (see docs/AI_MODEL.md).',
    );
  }
}

/**
 * Factory. Returns the configured provider, or the loud-failing default.
 *
 * Note there is no fallback chain: if AI_PROVIDER names a provider that cannot be
 * constructed, we do NOT quietly downgrade to "unconfigured" and let reports pile up
 * unanalysed. We fail at startup, where an operator will see it.
 */
export function createAiAnalyzer(config?: Partial<AiAnalyzerConfig>): AiAnalyzer {
  const resolved: AiAnalyzerConfig = {
    provider: config?.provider ?? 'unconfigured',
    model: config?.model ?? 'Xenova/clip-vit-base-patch32',
    cacheDir: config?.cacheDir ?? '.cache/hf',
    confidenceThreshold: config?.confidenceThreshold ?? 0.7,
    ambiguityMargin: config?.ambiguityMargin ?? 0.15,
    timeoutMs: config?.timeoutMs ?? 30_000,
    maxAttempts: config?.maxAttempts ?? 3,
    allowRemoteDownload: config?.allowRemoteDownload ?? true,
  };

  switch (resolved.provider) {
    case 'unconfigured':
      return new UnconfiguredAiAnalyzer();
    case 'local-clip':
      // Model-backed providers load a native runtime asynchronously, so they cannot be
      // constructed here. Refusing loudly beats returning a stub that never analyses.
      throw new Error(
        "createAiAnalyzer() is synchronous and supports only the 'unconfigured' provider. " +
          "For AI_PROVIDER=local-clip use createAiAnalyzerAsync().",
      );
    default:
      throw new Error(
        `Unknown AI_PROVIDER "${resolved.provider}". Supported: unconfigured, local-clip. ` +
          'Refusing to start rather than silently disabling AI analysis.',
      );
  }
}

/**
 * Async factory used by the application. Kept separate from createAiAnalyzer because
 * loading a vision runtime is inherently asynchronous, and pretending otherwise in a
 * sync signature would force a hidden lazy-load inside the first user request.
 */
export async function createAiAnalyzerAsync(
  config: Partial<AiAnalyzerConfig> & { loadEvidence: (evidenceRef: string) => Promise<Buffer> },
): Promise<AiAnalyzer> {
  const { loadEvidence, ...rest } = config;
  const resolved: AiAnalyzerConfig = {
    provider: rest.provider ?? 'unconfigured',
    model: rest.model ?? 'Xenova/clip-vit-base-patch32',
    cacheDir: rest.cacheDir ?? '.cache/hf',
    confidenceThreshold: rest.confidenceThreshold ?? 0.7,
    ambiguityMargin: rest.ambiguityMargin ?? 0.15,
    timeoutMs: rest.timeoutMs ?? 30_000,
    maxAttempts: rest.maxAttempts ?? 3,
    allowRemoteDownload: rest.allowRemoteDownload ?? true,
  };

  if (resolved.provider === 'unconfigured') return new UnconfiguredAiAnalyzer();
  if (resolved.provider !== 'local-clip') {
    throw new Error(
      `Unknown AI_PROVIDER "${resolved.provider}". Supported: unconfigured, local-clip.`,
    );
  }

  const { LocalClipAnalyzer } = await import('./clip.js');
  return new LocalClipAnalyzer({ ...resolved, loadEvidence });
}

/**
 * The human-review policy, defined in Phase 1 and WIRED UP in Phase 2's pipeline.
 *
 * Anything below the confidence threshold, any disagreement with the student's
 * selection, and any duplicate candidate at all MUST go to a human. Nothing uncertain
 * may drive an irreversible action (auto-approval, auto-merge, auto-award).
 */
export function requiresHumanReview(input: {
  confidence: number | null;
  categoryMatchesStudentSelection: boolean | null;
  duplicateCandidateCount: number;
}): boolean {
  if (input.confidence === null) return true;
  if (input.confidence < AI_REVIEW_CONFIDENCE_THRESHOLD) return true;
  if (input.categoryMatchesStudentSelection === false) return true;
  if (input.duplicateCandidateCount > 0) return true;
  return false;
}

/**
 * Validates a provider's raw output before anything is persisted (§7: "Validate all
 * model output before persisting it"; §18: "Model output is treated as untrusted
 * input"). A provider that returns a malformed object produces a permanent failure —
 * never a partially-written analysis row.
 */
export function validateAnalysisResult(raw: unknown, request: AiAnalysisRequest): AiAnalysisResult {
  const parsed = AiAnalysisResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AiMalformedOutputError(
      `AI provider returned output that failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const result = parsed.data;

  // The provider may not attribute an analysis to a different report than the one it
  // was asked about — a cross-report result would corrupt another student's record.
  if (result.reportId !== request.reportId) {
    throw new AiMalformedOutputError(
      `AI provider returned an analysis for report ${result.reportId} while analysing ${request.reportId}.`,
    );
  }

  // The predicted category must be one the caller offered. Guards against a provider
  // inventing an id, or returning a category that was deactivated mid-flight.
  if (result.predictedCategoryId !== null) {
    const offered = request.candidateCategories.some((c) => c.id === result.predictedCategoryId);
    if (!offered) {
      throw new AiPermanentError(
        `AI provider predicted category ${result.predictedCategoryId}, which is not in the active category set.`,
        'AI_UNSUPPORTED_CATEGORY',
      );
    }
  }

  return result;
}

/** Distinguishes AiAnalysisStatusSchema's vocabulary from the brief's wording. */
export const ANALYSIS_STATUS_NOTE =
  'Status vocabulary follows Phase 1 migration 0006: PENDING | SUCCEEDED | FAILED | ' +
  'NEEDS_HUMAN_REVIEW. The brief\'s PROCESSING maps to PENDING (the row is created only ' +
  'when analysis is attempted) and COMPLETED/NEEDS_REVIEW map to SUCCEEDED/NEEDS_HUMAN_REVIEW.';

// Re-exported for the pipeline and tests.
export { AI_REVIEW_CONFIDENCE_THRESHOLD };
export { AiMalformedOutputError, AiPermanentError, AiTransientError, AiTimeoutError } from './ai-errors.js';
export type { AiAnalysisResult, Severity };
