/**
 * Minimal, dependency-free .env loading + validated configuration.
 *
 * The brief forbids committing secrets and requires an accurate .env.example.
 * Values are validated once at startup so a misconfigured deployment fails loudly
 * at boot instead of at the first request.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AI_REVIEW_CONFIDENCE_THRESHOLD } from '@campus/contracts';

let loaded = false;

/** Loads .env from the repo root if present. Uses Node's built-in parser. */
export function loadDotEnv(cwd: string = process.cwd()): void {
  if (loaded) return;
  const file = path.join(cwd, '.env');
  if (existsSync(file) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(file);
    } catch {
      // A malformed .env must not crash tooling; explicit vars still work.
    }
  }
  loaded = true;
}

export interface AppConfig {
  /** When set, native PostgreSQL is used; otherwise PGlite. */
  databaseUrl?: string;
  /** PGlite on-disk directory. Unset = in-memory (tests). */
  pgliteDir?: string;
  port: number;
  host: string;
  nodeEnv: 'development' | 'test' | 'production';
  sessionTtlHours: number;
  evidenceDir: string;
  maxEvidenceBytes: number;
  logLevel: string;
  /** Global requests/minute per IP. */
  rateLimitMax: number;
  /** Login attempts/minute per IP (brief Section 10: login throttling). */
  loginRateLimitMax: number;
  /** Dev-only seed password; never used in production configuration. */
  demoSeedPassword?: string;

  /* ------------------------------------------------------------------ */
  /* AI provider (Phase 2). See docs/AI_MODEL.md.                        */
  /* ------------------------------------------------------------------ */

  /**
   * 'unconfigured' (default) keeps the honest 501 boundary. 'local-clip' enables the
   * on-device CLIP model. There is deliberately no default that silently turns AI on.
   */
  aiProvider: 'unconfigured' | 'local-clip';
  aiModel: string;
  /** Where model weights are cached. Pre-warm this for an offline demo. */
  aiCacheDir: string;
  /** Top-1 score below which a result MUST be reviewed by a human. */
  aiConfidenceThreshold: number;
  /** Top-1 minus top-2 below which a result is ambiguous, regardless of score. */
  aiAmbiguityMargin: number;
  aiTimeoutMs: number;
  aiMaxAttempts: number;
  /** false = air-gapped: weights must already be in the cache. */
  aiAllowRemoteDownload: boolean;
  /**
   * Run the analysis worker inside the API process. Simple and reliable for a
   * single-node deployment; the pipeline is transport-agnostic and can be moved out.
   */
  aiWorkerEnabled: boolean;
  /** Poll interval for the pending-report queue, in milliseconds. */
  aiWorkerIntervalMs: number;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer (received: "${raw}")`);
  }
  return n;
}

/** Same validation, but zero is allowed (used for "disabled" intervals). */
function nonNegativeIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer (received: "${raw}")`);
  }
  return n;
}

/** A probability in (0, 1). Rejected outright rather than silently clamped. */
function probabilityFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) {
    throw new Error(`Environment variable ${name} must be between 0 and 1 exclusive (received: "${raw}")`);
  }
  return n;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Environment variable ${name} must be a boolean (received: "${raw}")`);
}

/**
 * AI provider defaults, in ONE place.
 *
 * Both the application config and the test harness spread this, so adding a new AI
 * setting cannot silently leave tests running with a different configuration than
 * production. `unconfigured` is the default on purpose: AI is opt-in and must be
 * named explicitly, never switched on by the presence of a file on disk.
 */
export const AI_CONFIG_DEFAULTS = {
  aiProvider: 'unconfigured' as const,
  aiModel: 'Xenova/clip-vit-base-patch32',
  aiConfidenceThreshold: 0.7,
  aiAmbiguityMargin: 0.15,
  aiTimeoutMs: 30_000,
  aiMaxAttempts: 3,
  aiAllowRemoteDownload: true,
  aiWorkerEnabled: true,
  aiWorkerIntervalMs: 2_000,
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnvRaw = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnvRaw)) {
    throw new Error(`NODE_ENV must be development | test | production (received: "${nodeEnvRaw}")`);
  }
  const nodeEnv = nodeEnvRaw as AppConfig['nodeEnv'];

  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  const pgliteDir = env.PGLITE_DIR?.trim() || undefined;

  if (nodeEnv === 'production' && !databaseUrl) {
    // Guardrail: never run production on an in-process, single-writer database.
    throw new Error('DATABASE_URL is required when NODE_ENV=production (PGlite is single-process only).');
  }

  return {
    databaseUrl,
    pgliteDir,
    port: intFromEnv('PORT', 3001),
    host: env.HOST?.trim() || '0.0.0.0',
    nodeEnv,
    sessionTtlHours: intFromEnv('SESSION_TTL_HOURS', 8),
    evidenceDir: env.EVIDENCE_DIR?.trim() || path.resolve(process.cwd(), 'storage/evidence'),
    maxEvidenceBytes: intFromEnv('MAX_EVIDENCE_BYTES', 8 * 1024 * 1024),
    logLevel: env.LOG_LEVEL?.trim() || (nodeEnv === 'test' ? 'silent' : 'info'),
    rateLimitMax: intFromEnv('RATE_LIMIT_MAX', 300),
    loginRateLimitMax: intFromEnv('LOGIN_RATE_LIMIT_MAX', 10),
    demoSeedPassword: env.DEMO_SEED_PASSWORD?.trim() || undefined,

    aiProvider: (() => {
      const raw = (env.AI_PROVIDER ?? 'unconfigured').trim();
      if (raw !== 'unconfigured' && raw !== 'local-clip') {
        // Fail at boot rather than letting a typo silently disable AI analysis.
        throw new Error(`AI_PROVIDER must be "unconfigured" or "local-clip" (received: "${raw}")`);
      }
      return raw;
    })(),
    aiModel: env.AI_MODEL?.trim() || 'Xenova/clip-vit-base-patch32',
    aiCacheDir: env.AI_CACHE_DIR?.trim() || path.resolve(process.cwd(), '.cache/hf'),
    // 0.7 mirrors AI_REVIEW_CONFIDENCE_THRESHOLD in the shared contract. If they ever
    // disagree the contract wins, which would be a bug — so it is asserted in tests.
    aiConfidenceThreshold: probabilityFromEnv('AI_CONFIDENCE_THRESHOLD', AI_REVIEW_CONFIDENCE_THRESHOLD),
    aiAmbiguityMargin: probabilityFromEnv('AI_AMBIGUITY_MARGIN', 0.15),
    aiTimeoutMs: intFromEnv('AI_TIMEOUT_MS', 30_000),
    aiMaxAttempts: intFromEnv('AI_MAX_ATTEMPTS', 3),
    aiAllowRemoteDownload: boolFromEnv('AI_ALLOW_REMOTE_DOWNLOAD', true),
    aiWorkerEnabled: boolFromEnv('AI_WORKER_ENABLED', true),
    aiWorkerIntervalMs: nonNegativeIntFromEnv('AI_WORKER_INTERVAL_MS', 2_000),
  };
}
