/**
 * AI failure taxonomy.
 *
 * WHY THIS FILE EXISTS: §16 requires bounded retries for TRANSIENT failures and
 * forbids retrying PERMANENT ones. That distinction cannot be made at the call site —
 * it has to be a property of the error itself, decided where the failure is observed.
 *
 * Retrying a malformed image forever wastes the worker and delays the report; not
 * retrying a momentarily-unavailable model loses a report that would have succeeded
 * one second later. Both are bugs, and both are prevented here.
 */

/** A failure that may succeed if attempted again (model still loading, network blip, timeout). */
export class AiTransientError extends Error {
  readonly transient = true;
  constructor(
    message: string,
    readonly code: AiFailureCode = 'AI_PROVIDER_UNAVAILABLE',
  ) {
    super(message);
    this.name = 'AiTransientError';
  }
}

/** A failure that will NEVER succeed on retry (undecodable image, unsupported type). */
export class AiPermanentError extends Error {
  readonly transient = false;
  constructor(
    message: string,
    readonly code: AiFailureCode = 'AI_INVALID_EVIDENCE',
  ) {
    super(message);
    this.name = 'AiPermanentError';
  }
}

/** Distinguishable so the worker can log "too slow" separately from "broken". */
export class AiTimeoutError extends AiTransientError {
  constructor(readonly timeoutMs: number, context: string) {
    super(`AI inference exceeded ${timeoutMs} ms (${context})`, 'AI_TIMEOUT');
    this.name = 'AiTimeoutError';
  }
}

export type AiFailureCode =
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_TIMEOUT'
  | 'AI_INVALID_EVIDENCE'
  | 'AI_MALFORMED_OUTPUT'
  | 'AI_UNSUPPORTED_CATEGORY'
  | 'AI_EVIDENCE_NOT_FOUND'
  | 'AI_NOT_CONFIGURED';

/**
 * Failure codes that no amount of retrying can fix: the photograph itself is unusable, the
 * evidence is gone, or the model's output cannot be trusted. The background worker reads this
 * list to stop after ONE attempt instead of spending its full retry budget on a report that
 * will fail identically every time (.env.example: "A permanent failure is never retried").
 *
 * Kept here, beside the error classes, so adding a permanent error type and forgetting to
 * list it is visible in one file rather than in a SQL string elsewhere.
 */
export const PERMANENT_AI_FAILURE_CODES: readonly AiFailureCode[] = [
  'AI_INVALID_EVIDENCE',
  'AI_EVIDENCE_NOT_FOUND',
  'AI_MALFORMED_OUTPUT',
  'AI_UNSUPPORTED_CATEGORY',
];

/** Raised when the provider returned something that failed schema validation. */
export class AiMalformedOutputError extends AiPermanentError {
  constructor(message: string) {
    super(message, 'AI_MALFORMED_OUTPUT');
    this.name = 'AiMalformedOutputError';
  }
}

export interface RetryPolicy {
  /** Total attempts including the first. 1 = no retry. */
  maxAttempts: number;
  /** Base delay; grows exponentially and is jittered. */
  baseDelayMs: number;
  /** Injected so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 250 };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` with bounded retries. Retries ONLY AiTransientError; anything else
 * (permanent failure, or an unexpected programming error) propagates immediately.
 *
 * The attempt count is hard-bounded, so a persistently broken provider can never
 * spin forever — it fails, the report keeps its explicit FAILED analysis, and an
 * operator can retry deliberately.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  const sleep = policy.sleep ?? realSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (!(error instanceof AiTransientError)) throw error;
      if (attempt === policy.maxAttempts) break;
      // Exponential backoff with jitter: spreads out retries when several workers
      // hit the same cold model at once.
      const delay = policy.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      await sleep(Math.round(delay));
    }
  }
  throw lastError;
}

/** True when the error means "retry later", as opposed to "never". */
export function isTransient(error: unknown): boolean {
  return error instanceof AiTransientError;
}

/** Safe, human-readable failure description. Never includes file paths or credentials. */
export function describeAiFailure(error: unknown): { code: AiFailureCode; message: string } {
  if (error instanceof AiTransientError || error instanceof AiPermanentError) {
    return { code: error.code, message: error.message };
  }
  // Unexpected errors are NOT surfaced verbatim to avoid leaking internals.
  return { code: 'AI_PROVIDER_UNAVAILABLE', message: 'AI provider failed unexpectedly.' };
}

/** Rejects with AiTimeoutError if `promise` has not settled in time. */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, context: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AiTimeoutError(timeoutMs, context)), timeoutMs);
        // Do not hold the event loop open for a pending timeout.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
