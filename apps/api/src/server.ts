/**
 * Server entry point:  npm run dev  /  npm start
 *
 * Boot sequence is fail-fast: configuration is validated, migrations are applied,
 * and the database is probed BEFORE the port opens. A misconfigured deployment
 * fails at startup with a clear message instead of at the first request.
 */
import { createDb, loadConfig, loadDotEnv, runMigrations, type DbConfig } from '@campus/db';
import { createAiAnalyzerAsync, LocalEvidenceStorage, readEvidenceRef } from '@campus/domain';
import { buildApp } from './app.js';
import { createAnalysisWorker } from './worker.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const dbConfig: DbConfig = config.databaseUrl
    ? { url: config.databaseUrl }
    : { pgliteDir: config.pgliteDir ?? '.data/campus' };

  const db = await createDb(dbConfig);

  // Apply pending migrations on boot (idempotent).
  const { applied } = await runMigrations(db);
  if (applied.length > 0) console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);

  /*
   * THE AI ANALYZER IS CONSTRUCTED HERE, ONCE, AND SHARED.
   *
   * `buildApp` accepts an existing analyzer so the background worker and the HTTP
   * routes run the SAME instance. Constructing it twice would load the model twice —
   * roughly 149 MB of weights and about a second of startup each — and would mean the
   * queue and the manual retry endpoint could disagree about which model produced a
   * result. One process, one model, one answer to "which model is configured?".
   */
  const storage = new LocalEvidenceStorage({
    rootDir: config.evidenceDir,
    maxBytes: config.maxEvidenceBytes,
  });
  const ai = await createAiAnalyzerAsync({
    provider: config.aiProvider,
    model: config.aiModel,
    cacheDir: config.aiCacheDir,
    confidenceThreshold: config.aiConfidenceThreshold,
    ambiguityMargin: config.aiAmbiguityMargin,
    timeoutMs: config.aiTimeoutMs,
    maxAttempts: config.aiMaxAttempts,
    allowRemoteDownload: config.aiAllowRemoteDownload,
    // A READER, not the database: the adapter cannot query, write or award anything.
    loadEvidence: (ref: string) => readEvidenceRef(storage, ref),
  });

  const app = await buildApp({ db, config, ai });

  /*
   * THE BACKGROUND ANALYSIS WORKER (§4).
   *
   * Without it a submitted report is stored, sits at PENDING, and is never analysed —
   * so the review queue never fills, nothing is credited, and the student's report
   * never changes. It is started here rather than inside `buildApp` because it is a
   * process-level resource with a timer and a lifecycle, not part of the HTTP app;
   * keeping it out of `buildApp` also means the test suite never starts a poller.
   */
  const worker = createAnalysisWorker({
    db,
    ai,
    intervalMs: config.aiWorkerIntervalMs,
    maxAttempts: config.aiMaxAttempts,
    log: app.log,
  });

  if (config.aiWorkerEnabled) {
    // Start after the port is open. A slow first sweep must not delay readiness, and
    // the health endpoint is what a supervisor should be watching.
    app.addHook('onReady', async () => {
      worker.start();
    });
  } else {
    app.log.warn(
      {},
      'AI_WORKER_ENABLED=false — reports will NOT be analysed automatically. ' +
        'They stay PENDING until POST /v1/reports/:id/analyze is called by an operator.',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      // Stop polling and let an in-flight analysis finish before the database closes,
      // so a report is never left half-written by a restart.
      await worker.stop();
      await app.close();
      await db.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });

  const engineLabel = db.engine === 'postgres' ? 'native PostgreSQL' : `PGlite (${dbConfig.pgliteDir})`;
  app.log.info(
    { port: config.port, host: config.host, engine: engineLabel, nodeEnv: config.nodeEnv },
    'AI Sustainable Campus API ready',
  );
  if (config.nodeEnv === 'development') {
    app.log.info('Demo accounts are created by `npm run seed`. See docs/RUNBOOK.md.');
  }
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:');
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
