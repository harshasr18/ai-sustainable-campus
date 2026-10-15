/**
 * Background analysis worker.
 *
 * WHY THIS FILE HAD TO EXIST. Through Phase 3 the only way to analyse a report was to
 * call `POST /v1/reports/:id/analyze` by hand, as an operator. Nothing consumed the
 * queue. A student could submit a photograph, the report would be stored correctly at
 * `validation_status='PENDING'`, and it would sit there indefinitely: no analysis, no
 * review entry, no token credit, forever. The configuration for the worker was already
 * in the project — `AI_WORKER_ENABLED`, `AI_WORKER_INTERVAL_MS`, and a line in
 * `.env.example` describing it as "polls for reports with validation_status='PENDING'"
 * — but no code read it. §2 is explicit about that failure mode: "Ensure the worker is
 * not silently omitted when it is required for processing." It was omitted silently.
 *
 * WHAT IT IS NOT ALLOWED TO DO. It cannot approve anything, cannot merge a duplicate,
 * cannot resolve an issue and cannot touch the token ledger. `runAnalysis` is the same
 * pipeline function the manual endpoint calls, and all it does is write an analysis row
 * and the report's denormalized `ai_*` columns. The 10-token credit stays where Phase 2
 * put it: behind `POST /v1/reports/:id/validation`, which a human triggers. So a worker
 * retry cannot double-credit a report — it cannot credit one at all.
 *
 * IDEMPOTENCE. Two mechanisms, deliberately independent:
 *
 *   1. IN-PROCESS: a report currently being analysed is held in `inFlight`, so a slow
 *      inference cannot be started a second time by the next tick.
 *   2. IN THE DATABASE: the queue query skips reports that already have a usable
 *      analysis, so after a restart — when `inFlight` is empty and knows nothing — the
 *      work simply is not there any more. The durable guarantee does not depend on
 *      process memory surviving.
 *
 * FAILURE HANDLING. Every failure goes down the existing path: `runAnalysis` catches it,
 * writes a FAILED `ai_analyses` row with a machine-readable code, leaves
 * `validation_status` untouched so the report is still recoverable, and publishes
 * nothing that implies success. The worker does not add a second, competing error
 * convention — it logs and moves on.
 *
 * AN UNCONFIGURED PROVIDER IS NOT A FAILURE. With `AI_PROVIDER=unconfigured` there is
 * no model to run. The worker detects that at startup and idles, saying so once, rather
 * than treating each report as a failed attempt — which would exhaust the three-attempt
 * budget of every queued report before AI was ever switched on, so that enabling the
 * model later would find nothing left to do.
 */

import type { AiAnalyzer } from '@campus/domain';
import { aiAnalyses as analysisRepo, type Db } from '@campus/db';
import { runAnalysis } from './routes/analysis.js';

export interface AnalysisWorkerOptions {
  db: Db;
  ai: AiAnalyzer;
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Failed attempts allowed per report before it is left for a human. */
  maxAttempts: number;
  /** Reports processed per tick. Small on purpose: one CPU, one model instance. */
  batchSize?: number;
  log: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

export interface AnalysisWorker {
  /** Begins polling. Returns immediately; the first sweep runs on the next tick. */
  start: () => void;
  /** Stops polling and waits for any in-progress batch to finish. */
  stop: () => Promise<void>;
  /** Runs exactly one sweep and returns what it did. Exposed so tests can be deterministic. */
  sweep: () => Promise<SweepResult>;
}

export interface SweepResult {
  considered: number;
  analysed: number;
  usable: number;
  failed: number;
  skipped: number;
}

export function createAnalysisWorker(options: AnalysisWorkerOptions): AnalysisWorker {
  const { db, ai, intervalMs, maxAttempts, log } = options;
  const batchSize = options.batchSize ?? 5;

  /** Reports being analysed right now, so a slow inference is not started twice. */
  const inFlight = new Set<string>();

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopping = false;

  /**
   * One pass over the queue.
   *
   * Workspaces are enumerated rather than assumed: a DEMO report must be analysed with
   * its own workspace's categories and must publish its event labelled DEMO. §11 treats
   * mixing the two as a defect, and the event envelope is data, so the workspace kind is
   * carried through to `runAnalysis` instead of being inferred or hardcoded.
   */
  async function sweep(): Promise<SweepResult> {
    const result: SweepResult = { considered: 0, analysed: 0, usable: 0, failed: 0, skipped: 0 };

    const workspaces = await db.query<{ id: string; kind: 'REAL' | 'DEMO' }>(
      `SELECT id, kind FROM workspaces ORDER BY kind`,
    );

    for (const workspace of workspaces.rows) {
      const queued = await analysisRepo.listAwaitingAnalysis(db, workspace.id, maxAttempts, batchSize);

      for (const item of queued) {
        result.considered += 1;

        if (inFlight.has(item.reportId)) {
          result.skipped += 1;
          continue;
        }

        inFlight.add(item.reportId);
        try {
          /*
           * `actorUserId: null` — the worker is not a person. Writing a staff user id
           * here would attribute an automated action to a human in the audit trail, and
           * the audit trail is exactly where that distinction has to survive.
           */
          const outcome = await runAnalysis(
            db,
            ai,
            workspace.id,
            item.reportId,
            null,
            item.workspaceKind,
          );

          result.analysed += 1;
          if (outcome.status === 'SUCCEEDED' || outcome.status === 'NEEDS_HUMAN_REVIEW') {
            result.usable += 1;
          } else {
            result.failed += 1;
          }

          log.info(
            {
              reportId: item.reportId,
              workspace: item.workspaceKind,
              status: outcome.status,
              confidence: outcome.confidence,
              requiresHumanReview: outcome.requiresHumanReview,
              latencyMs: outcome.latencyMs,
            },
            'analysis completed',
          );
        } catch (error) {
          /*
           * A throw from `runAnalysis` means the pipeline could not even reach the model
           * — a missing report, no stored photograph, or an unconfigured provider. It is
           * NOT recorded as an attempt, because none was made.
           */
          result.skipped += 1;
          log.warn(
            { reportId: item.reportId, err: error instanceof Error ? error.message : String(error) },
            'analysis skipped',
          );
        } finally {
          inFlight.delete(item.reportId);
        }
      }
    }

    return result;
  }

  async function tick(): Promise<void> {
    if (running || stopping) return;
    running = true;
    try {
      const result = await sweep();
      if (result.analysed > 0) {
        log.info(result, 'analysis sweep finished');
      }
    } catch (error) {
      // A failed sweep must not kill the worker: the next tick tries again.
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'analysis sweep failed');
    } finally {
      running = false;
    }
  }

  return {
    sweep,

    start(): void {
      if (timer) return;

      if (ai.provider === 'unconfigured') {
        /*
         * Say it once, clearly, and then do nothing. This is the honest state: reports
         * queue up and are analysed the moment a provider is configured. Silently
         * failing them three times each would be the opposite of honest.
         */
        log.warn(
          {},
          'analysis worker is enabled but AI_PROVIDER=unconfigured, so there is no model to run. ' +
            'Reports will stay PENDING and will be analysed when AI_PROVIDER=local-clip is set ' +
            '(see docs/AI_MODEL.md). No attempts are recorded while the provider is unconfigured.',
        );
        return;
      }

      log.info({ intervalMs, maxAttempts, batchSize }, 'analysis worker started');
      timer = setInterval(() => void tick(), intervalMs);
      // Do not hold the process open purely for the poll timer.
      timer.unref?.();
    },

    async stop(): Promise<void> {
      stopping = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Let an in-progress batch finish rather than abandoning a half-written analysis.
      const deadline = Date.now() + 10_000;
      while (running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}
