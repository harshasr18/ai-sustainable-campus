/**
 * Local CLIP vision adapter — a GENUINE computer-vision classifier.
 *
 * WHAT IT DOES: runs the open CLIP ViT-B/32 image encoder (ONNX, quantized) on CPU via
 * Transformers.js, and performs zero-shot classification by comparing the image
 * embedding against the text embeddings of the ACTIVE categories read from the
 * database. No API key, no paid service, no network call at inference time.
 *
 * WHAT IT IS NOT: it is not a fine-tuned defect detector, and its softmax score is NOT
 * a calibrated probability. §10 forbids presenting an uncalibrated score as one, so
 * the score is treated as a thresholded ranking signal with an explicit ambiguity
 * margin, and every result carries the model identity so a later, better model can be
 * compared against it without rewriting history.
 *
 * WHY CLIP AND NOT AN IMAGE-CLASSIFICATION CNN: a pretrained ImageNet classifier has a
 * fixed 1000-class output head and cannot express "water leakage" at all — it would
 * need labelled defect data that does not exist yet. CLIP classifies into whatever
 * categories the caller supplies, which keeps categories as configurable data (Phase 1
 * design) and requires no retraining when a category is added.
 *
 * PRIVACY: inference happens in this process. Student photographs are never uploaded to
 * a third party. The only network access is the one-time weight download, which can be
 * disabled entirely with AI_ALLOW_REMOTE_DOWNLOAD=false.
 */
import type { AiAnalysisResult } from '@campus/contracts';
import {
  AiPermanentError,
  AiTransientError,
  describeAiFailure,
  withRetry,
  withTimeout,
  type RetryPolicy,
} from './ai-errors.js';
import {
  assertUsableDimensions,
  decodeWithTransformers,
  MIN_IMAGE_EDGE_PX,
  type ImageDecoder,
} from './image-decode.js';
import {
  validateAnalysisResult,
  requiresHumanReview,
  type AiAnalysisRequest,
  type AiAnalyzer,
  type AiAnalyzerConfig,
  type CandidateCategory,
} from './ai.js';

/** Label for "the photograph shows a normal, well-maintained area". */
export const NOTHING_WRONG_LABEL =
  'a photo of a clean, tidy, well-maintained building or path with nothing broken, damaged or dirty';

/** Below this, a classified image is effectively a thumbnail; the result is advisory. */
export const LOW_RESOLUTION_EDGE_PX = 224;

export interface LoadedPipeline {
  (image: unknown, labels: string[], options?: Record<string, unknown>): Promise<
    { label: string; score: number }[]
  >;
}

export interface LocalClipAnalyzerOptions extends AiAnalyzerConfig {
  /** Resolves an opaque storage reference to bytes. Never a public URL. */
  loadEvidence: (evidenceRef: string) => Promise<Buffer>;
  /** Test seam: inject a deterministic pipeline instead of loading the real model. */
  classifier?: LoadedPipeline;
  /** Test seam: inject a decoder so no ONNX runtime is loaded. */
  decodeImage?: ImageDecoder;
  /** Test seam: inject a fast retry policy (no real sleeping). */
  retryPolicy?: RetryPolicy;
}

/**
 * Builds the prompt CLIP compares against the image. Kept separate so it is testable.
 *
 * THE WORDING IS MEASURED, NOT GUESSED. `scripts/ai-eval-prompts.mjs` ranks candidate
 * templates against the fixture set. Results — on 7 synthetic fixtures, so this ranks
 * TEMPLATES and is not an accuracy claim:
 *
 *   a photo of {name}, a maintenance defect: {description}   6/7, 0 confident errors  <= chosen
 *   curated hand-written visual phrase                       6/7, 0 confident errors
 *   a photo of {name}, {description}                         5/7, 0 confident errors
 *   a photo of {name}                                        4/7, 1 CONFIDENT ERROR
 *
 * "Name only" is rejected for a specific reason: it produced a wrong answer at 0.863
 * confidence, i.e. an error that would have cleared the human-review threshold and been
 * trusted. The description is what disambiguates "Water Leakage" from "Damaged Toilets".
 *
 * The curated template scores the same but is rejected anyway: it hardcodes eight
 * English phrases in source, which would break the Phase 1 rule that categories are
 * configurable DATA. A new category must work with no code change, and this template
 * does. `description` is therefore a first-class input to classification — if you edit
 * a category's description, you are editing its prompt.
 */
export function buildLabels(categories: CandidateCategory[]): Map<string, CandidateCategory> {
  const byLabel = new Map<string, CandidateCategory>();
  for (const category of categories) {
    const hint = category.description ? `, a maintenance defect: ${category.description.toLowerCase()}` : '';
    byLabel.set(`a photo of ${category.name.toLowerCase()}${hint}`, category);
  }
  return byLabel;
}

export class LocalClipAnalyzer implements AiAnalyzer {
  readonly provider = 'local-clip';
  readonly model: string;
  readonly modelVersion = 'onnx-q8';

  private pipelinePromise: Promise<LoadedPipeline> | null = null;
  private loadCount = 0;

  constructor(private readonly options: LocalClipAnalyzerOptions) {
    this.model = options.model;
  }

  /** Number of times the model has actually been loaded. 1 = loaded once and reused. */
  get loadCountValue(): number {
    return this.loadCount;
  }

  /**
   * Loads the model once and shares the promise, so N concurrent reports arriving at a
   * cold server trigger ONE load rather than N — which on a laptop is the difference
   * between a 3-second spike and thrashing the machine.
   */
  private async getPipeline(): Promise<LoadedPipeline> {
    if (this.options.classifier) return this.options.classifier;
    if (!this.pipelinePromise) {
      this.pipelinePromise = this.loadPipeline().catch((error) => {
        // Do not cache a failed load: the next report deserves a fresh attempt.
        this.pipelinePromise = null;
        throw error;
      });
    }
    return this.pipelinePromise;
  }

  private async loadPipeline(): Promise<LoadedPipeline> {
    const t0 = Date.now();
    this.loadCount += 1;
    let transformers: typeof import('@huggingface/transformers');
    try {
      transformers = await import('@huggingface/transformers');
    } catch (error) {
      throw new AiPermanentError(
        'The vision runtime (@huggingface/transformers) is not installed. Run: npm install',
        'AI_PROVIDER_UNAVAILABLE',
      );
    }

    const { pipeline, env } = transformers;
    env.cacheDir = this.options.cacheDir;
    env.allowRemoteModels = this.options.allowRemoteDownload;

    try {
      const loaded = (await pipeline('zero-shot-image-classification', this.options.model, {
        dtype: 'q8',
        device: 'cpu',
      })) as unknown as LoadedPipeline;
      this.lastLoadMs = Date.now() - t0;
      return loaded;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // A missing/unreachable model is transient (network); a bad model NAME is not.
      if (/not found|no such|invalid model|does not exist/i.test(detail)) {
        throw new AiPermanentError(
          `Vision model "${this.options.model}" could not be loaded: ${detail}`,
          'AI_PROVIDER_UNAVAILABLE',
        );
      }
      throw new AiTransientError(`Vision model failed to load: ${detail}`, 'AI_PROVIDER_UNAVAILABLE');
    }
  }

  private lastLoadMs = 0;
  /** Time spent loading the model, for the operator log. 0 = reused a warm model. */
  get loadLatencyMs(): number {
    return this.lastLoadMs;
  }

  async warmup(): Promise<void> {
    await this.getPipeline();
  }

  /**
   * Decode + dimension policy, delegated to the injected decoder.
   *
   * Tests inject a fake so no ONNX runtime is loaded; production uses the real
   * Transformers.js decoder. See adapters/image-decode.ts.
   */
  private async decode(bytes: Buffer, mimeType: string): Promise<unknown> {
    const decoder = this.options.decodeImage ?? decodeWithTransformers;
    const decoded = await decoder(bytes, mimeType);
    assertUsableDimensions(decoded);
    this.lastImageEdgePx = Math.min(decoded.width, decoded.height);
    return decoded.handle;
  }

  private lastImageEdgePx = 0;

  async analyze(request: AiAnalysisRequest): Promise<AiAnalysisResult> {
    const retryPolicy: RetryPolicy = this.options.retryPolicy ?? {
      maxAttempts: this.options.maxAttempts,
      baseDelayMs: 250,
    };

    return withRetry(
      () => withTimeout(this.analyzeOnce(request), this.options.timeoutMs, `report ${request.reportId}`),
      retryPolicy,
    );
  }

  private async analyzeOnce(request: AiAnalysisRequest): Promise<AiAnalysisResult> {
    if (request.candidateCategories.length === 0) {
      throw new AiPermanentError(
        'No active issue categories were supplied, so there is nothing to classify against.',
        'AI_UNSUPPORTED_CATEGORY',
      );
    }

    // 1. Load evidence (authorization already performed by the caller).
    let bytes: Buffer;
    try {
      bytes = await this.options.loadEvidence(request.evidenceRef);
    } catch (error) {
      throw new AiPermanentError(
        `Evidence could not be read for analysis: ${error instanceof Error ? error.message : String(error)}`,
        'AI_EVIDENCE_NOT_FOUND',
      );
    }

    // 2. Decode + dimension check.
    const image = await this.decode(bytes, request.mimeType);

    // 3. Classify against the ACTIVE categories plus an explicit "nothing wrong" option,
    //    so the model always has somewhere honest to put a photograph of a healthy campus.
    const categories = [...request.candidateCategories];
    const byLabel = buildLabels(categories);
    const labels = [...byLabel.keys(), NOTHING_WRONG_LABEL];

    const classifier = await this.getPipeline();
    const scores = await classifier(image, labels, { hypothesis_template: '{}' });
    if (!Array.isArray(scores) || scores.length === 0) {
      throw new AiTransientError('Vision model returned no scores.', 'AI_MALFORMED_OUTPUT');
    }

    // 4. Rank. The pipeline returns scores already sorted, but nothing about the
    //    interface guarantees it, so ordering is established here rather than assumed.
    const ranked = [...scores].sort((a, b) => b.score - a.score);
    const top = ranked[0]!;
    const runnerUp = ranked[1];
    const margin = runnerUp ? top.score - runnerUp.score : top.score;

    const matched = byLabel.get(top.label) ?? null;
    const isNothingWrong = !matched;

    const predictedCategoryId = matched ? matched.id : null;
    const categoryMatchesStudentSelection =
      predictedCategoryId === null ? null : matched!.slug === request.selectedCategorySlug;

    // Confidence in a CATEGORY. When the model says "nothing wrong", there is no
    // category to be confident about, so this is null — which the policy below turns
    // into a human review rather than an automatic rejection of the student's report.
    const confidence = isNothingWrong ? null : top.score;

    // An ambiguous result (top two labels nearly tied) is treated as low confidence
    // regardless of how high the winning score happens to be.
    const ambiguous = margin < this.options.ambiguityMargin;

    const reviewRequired =
      requiresHumanReview({
        confidence,
        categoryMatchesStudentSelection,
        duplicateCandidateCount: 0,
      }) || ambiguous;

    const status = reviewRequired ? 'NEEDS_HUMAN_REVIEW' : 'SUCCEEDED';

    const result: AiAnalysisResult = {
      reportId: request.reportId,
      provider: this.provider,
      model: this.model,
      modelVersion: this.modelVersion,
      status,
      predictedCategoryId,
      categoryMatchesStudentSelection,
      confidence,
      // Severity and repair recommendations are Stage 6. Returning null here is the
      // honest answer: this model classifies, it does not diagnose.
      severity: null,
      repairRecommendation: null,
      duplicateCandidates: [],
      requiresHumanReview: reviewRequired,
    };

    // 5. Validate before returning, so an invalid result can never be persisted.
    const validated = validateAnalysisResult(result, request);

    this.lastDiagnostics = {
      ranked: ranked.slice(0, 3).map((s) => ({ label: s.label, score: Number(s.score.toFixed(4)) })),
      margin: Number(margin.toFixed(4)),
      ambiguous,
      nothingWrong: isNothingWrong,
      imageEdgePx: this.lastImageEdgePx,
    };
    return validated;
  }

  /** Last run's ranking, exposed for logs and the operator console. Not persisted. */
  lastDiagnostics: {
    ranked: { label: string; score: number }[];
    margin: number;
    ambiguous: boolean;
    nothingWrong: boolean;
    imageEdgePx: number;
  } | null = null;

  /** Health/status view for the operator endpoint. Says nothing it has not measured. */
  describe(): Record<string, unknown> {
    return {
      provider: this.provider,
      model: this.model,
      modelVersion: this.modelVersion,
      loaded: this.pipelinePromise !== null,
      loadCount: this.loadCount,
      loadLatencyMs: this.lastLoadMs,
      confidenceThreshold: this.options.confidenceThreshold,
      ambiguityMargin: this.options.ambiguityMargin,
      timeoutMs: this.options.timeoutMs,
      maxAttempts: this.options.maxAttempts,
      allowRemoteDownload: this.options.allowRemoteDownload,
      minImageEdgePx: MIN_IMAGE_EDGE_PX,
    };
  }
}

export { describeAiFailure };
