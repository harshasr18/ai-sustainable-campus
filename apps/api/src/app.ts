/**
 * Application assembly.
 *
 * `buildApp` takes its dependencies as arguments rather than reaching for globals,
 * so tests can construct a fully working server against an in-memory PGlite database
 * with zero setup and no network. That is what makes the automated test suite fast
 * enough to run on every change during a 24-48 hour build.
 */
import { createRequire } from 'node:module';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { validatorCompiler } from 'fastify-type-provider-zod';
import {
  createAiAnalyzerAsync,
  LocalEvidenceStorage,
  type AiAnalyzer,
  type EvidenceStorage,
} from '@campus/domain';
import type { AppConfig, Db } from '@campus/db';
import { registerErrorHandler } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCampusRoutes } from './routes/campus.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerIssueRoutes } from './routes/issues.js';
import { registerTokenRoutes } from './routes/tokens.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerAnalysisRoutes } from './routes/analysis.js';
import { registerConsoleRoute } from './routes/console.js';

export interface BuildAppOptions {
  db: Db;
  config: AppConfig;
  storage?: EvidenceStorage;
  ai?: AiAnalyzer;
  /** Reserved for the Phase 2 transport; always false in Phase 1. */
  realtimeEnabled?: boolean;
}

/** True when an optional module can be resolved, without importing it. */
function isModuleAvailable(name: string): boolean {
  try {
    // createRequire keeps this synchronous and avoids top-level await in a sync path.
    createRequire(import.meta.url).resolve(name);
    return true;
  } catch {
    return false;
  }
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { db, config } = options;

  const storage =
    options.storage ??
    new LocalEvidenceStorage({ rootDir: config.evidenceDir, maxBytes: config.maxEvidenceBytes });
  // AI provider (§7). Constructed from configuration, never guessed: an unconfigured
  // deployment keeps the honest 501 boundary, and a misconfigured one fails at boot
  // rather than silently analysing nothing.
  const ai =
    options.ai ??
    (await createAiAnalyzerAsync({
      provider: config.aiProvider,
      model: config.aiModel,
      cacheDir: config.aiCacheDir,
      confidenceThreshold: config.aiConfidenceThreshold,
      ambiguityMargin: config.aiAmbiguityMargin,
      timeoutMs: config.aiTimeoutMs,
      maxAttempts: config.aiMaxAttempts,
      allowRemoteDownload: config.aiAllowRemoteDownload,
      // The adapter is handed a READER, not the database. It cannot query, write, or
      // award anything — see the note at the top of domain/adapters/ai.ts.
      loadEvidence: (ref: string) => readEvidenceRef(storage, ref),
    }));

  // Pretty logs are a DEVELOPMENT nicety, never a hard dependency: if pino-pretty is
  // absent we silently fall back to structured JSON rather than refusing to boot.
  const usePrettyTransport =
    config.nodeEnv === 'development' && isModuleAvailable('pino-pretty');

  const app = Fastify({
    logger:
      config.nodeEnv === 'test'
        ? false
        : {
            level: config.logLevel,
            // Structured logs. Never log request bodies: they contain passwords and photos.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.email',
                'res.headers["set-cookie"]',
              ],
              censor: '[REDACTED]',
            },
            transport: usePrettyTransport
              ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
              : undefined,
          },
    // Trust the platform proxy so `request.ip` is meaningful for rate limiting.
    trustProxy: true,
    bodyLimit: Math.max(config.maxEvidenceBytes + 1024 * 1024, 2 * 1024 * 1024),
    genReqId: () => crypto.randomUUID(),
  });

  app.setValidatorCompiler(validatorCompiler);

  // Global safety net; auth routes tighten this further per-route.
  // Configurable so the test suite can raise the ceiling while a dedicated test
  // lowers it to PROVE throttling actually rejects excessive attempts.
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: '1 minute',
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.maxEvidenceBytes,
      files: 1, // exactly one photo per report
      fields: 25,
      parts: 30,
    },
  });

  registerErrorHandler(app);

  /* ----------------------------- health ----------------------------- */
  app.get('/healthz', async () => {
    const started = Date.now();
    try {
      await db.query('SELECT 1 AS ok');
      return {
        status: 'ok',
        database: { ok: true, latencyMs: Date.now() - started, error: null },
        version: '0.1.0-phase1',
        uptimeSeconds: Math.round(process.uptime()),
        engine: db.engine,
      };
    } catch (err) {
      // Report degraded rather than pretending healthy — the brief forbids returning
      // success when a required operation actually failed.
      return {
        status: 'degraded',
        database: {
          ok: false,
          latencyMs: null,
          error: err instanceof Error ? err.message : 'database unavailable',
        },
        version: '0.1.0-phase1',
        uptimeSeconds: Math.round(process.uptime()),
        engine: db.engine,
      };
    }
  });

  registerAuthRoutes(app, { db, config });
  registerCampusRoutes(app, { db });
  registerReportRoutes(app, { db, storage, maxEvidenceBytes: config.maxEvidenceBytes });
  registerIssueRoutes(app, { db });
  registerTokenRoutes(app, { db });
  registerAdminRoutes(app, { db });
  registerIntegrationRoutes(app, { db, ai, realtimeEnabled: options.realtimeEnabled ?? false });
  registerAnalysisRoutes(app, { db, ai });
  // Development-only browser console at `/`. Never registered in production.
  registerConsoleRoute(app, { config });

  return app;
}

/**
 * Resolves an opaque evidence reference (as produced by `storage.toReference`) back to
 * bytes. Only this function knows how a reference maps onto a storage adapter, so the
 * AI layer can be handed a reader without ever seeing a path, a URL, or the database.
 */
function readEvidenceRef(storage: EvidenceStorage, reference: string): Promise<Buffer> {
  const prefix = `${storage.kind}://`;
  const key = reference.startsWith(prefix) ? reference.slice(prefix.length) : reference;
  return storage.read(key);
}
