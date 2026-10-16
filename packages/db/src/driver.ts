/**
 * Database driver — ONE interface over two engines.
 *
 *   native PostgreSQL (pg)   -> the demo / release build
 *   PGlite (Postgres in WASM) -> zero-install dev + automated tests
 *
 * Both are genuine PostgreSQL, verified in Stage 1 to enforce the same partial
 * unique indexes, ON CONFLICT semantics, FOR UPDATE locking and advisory locks.
 * That is why identical SQL is safe on both.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/** A narrow surface: anything the codebase needs from a database connection. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Multi-statement DDL. Only valid OUTSIDE an explicit transaction. */
  exec(sql: string): Promise<void>;
}

/** Inside `withTransaction` the ONLY handle you get. Enforces the pattern. */
export interface Tx extends Queryable {}

export interface Db extends Queryable {
  readonly engine: 'pglite' | 'postgres';
  /**
   * The single sanctioned way to mutate state. Everything in the callback commits
   * atomically or not at all. A thrown error rolls back and is RE-THROWN, so a
   * failed write can never surface to a client as a success.
   */
  withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** PostgreSQL error codes we branch on. Kept explicit so intent is greppable. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  /** "current transaction is aborted" — thrown for ANY error after a failed statement. */
  IN_FAILED_TRANSACTION: '25P02',
} as const;

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_ERROR.UNIQUE_VIOLATION;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_ERROR.FOREIGN_KEY_VIOLATION;
}

/** A unique violation naming a specific constraint, so callers branch on identity not on text. */
export function violatesConstraint(err: unknown, constraintName: string): boolean {
  if (!isUniqueViolation(err)) return false;
  const c = (err as { constraint?: string }).constraint ?? '';
  return c === constraintName;
}

/* ------------------------------------------------------------------ */
/* PGlite                                                              */
/* ------------------------------------------------------------------ */

export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { mkdirSync } = await import('node:fs');
  if (dataDir) {
    // PGlite does not create parent directories itself.
    mkdirSync(dataDir, { recursive: true });
  }
  // In-memory when no dataDir: each test file gets a pristine, isolated database.
  const db: PGlite = dataDir ? new PGlite(dataDir) : new PGlite();

  /*
   * AN UNOPENABLE DATA DIRECTORY IS A DIAGNOSIS, NOT A CRASH.
   *
   * PGlite reports every failure to start as "PGlite failed to initialize properly",
   * with no cause attached. That message is misleading in the one situation that
   * actually produces it: a data directory that was COPIED WHILE THE DATABASE WAS
   * RUNNING. A PostgreSQL cluster is only consistent once the process has shut down
   * cleanly, so a directory captured mid-write (by a file sync, a snapshot, a backup
   * script, or a hard kill) is left with a WAL that cannot be replayed, and the next
   * start refuses to open it.
   *
   * The failure is therefore re-thrown with the cause named and the recovery spelled
   * out. Nothing here ever deletes or repairs the directory on its own: silently
   * discarding a database because it failed to open would be far worse than the
   * original error.
   */
  try {
    await db.waitReady;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The PGlite data directory at "${dataDir}" could not be opened.\n\n` +
        `  Reason given by the engine: ${detail}\n\n` +
        '  The usual cause is a data directory that was copied or snapshotted while the\n' +
        '  database was still running, which leaves it inconsistent and unopenable.\n\n' +
        '  If the data in it is disposable (a local development or DEMO database):\n' +
        `      npm run db:reset          # rebuilds "${dataDir}", migrates, seeds campus data\n\n` +
        '  If you need to keep it for inspection, move it aside instead — the original\n' +
        '  files are preserved and a new cluster is created on the next start:\n' +
        `      mv ${dataDir} ${dataDir}.unreadable\n\n` +
        '  To use a different location, set PGLITE_DIR in .env.',
    );
  }

  /**
   * Dev-time deadlock guard.
   *
   * PGlite is a SINGLE-connection engine. If code opens a transaction and then issues
   * a query through the OUTER handle, the transaction holds the connection while
   * waiting for the callback, and the callback waits for the connection — a permanent
   * hang with no error. That is a genuinely confusing failure to debug, so it is
   * converted into an explicit, actionable error instead.
   *
   * The rule it enforces: inside `withTransaction`, use ONLY the provided `tx` handle.
   */
  /*
   * Phase 5 fix — CONCURRENT REQUESTS. This used to be a single process-wide counter, so a
   * query from ANY other request while one request held a transaction threw — a random 500
   * for whoever came second (two HODs, a student and the analysis worker, ...). Found by a
   * concurrent duplicate-merge test. The misuse the guard exists for is narrower: the outer
   * handle used from INSIDE the transaction's own callback (that would wait on itself
   * forever). AsyncLocalStorage tells the two apart: the transaction's own async context is
   * refused, everyone else waits their turn on a FIFO lock. PGlite has one connection, so
   * serialising costs no throughput.
   */
  const insideTransaction = new AsyncLocalStorage<true>();
  let tail: Promise<void> = Promise.resolve();
  const acquire = (): Promise<() => void> => {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const previous = tail;
    tail = previous.then(() => mine);
    return previous.then(() => release);
  };

  return {
    engine: 'pglite',
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      if (insideTransaction.getStore()) {
        throw new Error(
          'Deadlock prevented: a query was issued on the outer database handle while a ' +
            'transaction was open. PGlite has a single connection, so this would hang forever. ' +
            'Inside withTransaction(tx => ...) use the provided `tx` handle instead of the outer db.',
        );
      }
      const release = await acquire();
      try {
        const r = await db.query<T>(sql, params as never[] | undefined);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      } finally {
        release();
      }
    },
    async exec(sql: string) {
      if (insideTransaction.getStore()) {
        throw new Error('Deadlock prevented: exec() called on the outer handle inside a transaction.');
      }
      const release = await acquire();
      try {
        await db.exec(sql);
      } finally {
        release();
      }
    },
    async withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      if (insideTransaction.getStore()) {
        throw new Error('Nested transactions are not supported. Use the existing `tx` handle.');
      }
      const release = await acquire();
      try {
        return await insideTransaction.run(true, () => db.transaction(async (tx) => {
          const handle: Tx = {
            async query<T>(sql: string, params?: unknown[]) {
              const r = await tx.query<T>(sql, params as never[] | undefined);
              return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
            },
            async exec(sql: string) {
              await tx.exec(sql);
            },
          };
          return fn(handle);
        }));
      } finally {
        release();
      }
    },
    async close() {
      await db.close();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Native PostgreSQL                                                   */
/* ------------------------------------------------------------------ */

export interface PgDbOptions {
  connectionString: string;
  max?: number;
  /** Single statement timeout guard so a runaway query cannot pin the pool. */
  statementTimeoutMs?: number;
}

export async function createPgDb(options: PgDbOptions): Promise<Db> {
  const { Pool } = await import('pg');
  const pool: Pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
  });
  // Fail fast on a bad connection string rather than at first request.
  const probe = await pool.connect();
  probe.release();

  return {
    engine: 'postgres',
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const r = await pool.query(sql, params as never[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          async query<T>(sql: string, params?: unknown[]) {
            const r = await client.query(sql, params as never[]);
            return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
          },
          async exec(sql: string) {
            await client.query(sql);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        // Rollback is best-effort; the original error is what matters and is re-thrown.
        try {
          await client.query('ROLLBACK');
        } catch {
          /* connection already broken — nothing useful to do */
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Factory — environment driven                                        */
/* ------------------------------------------------------------------ */

export interface DbConfig {
  /** e.g. postgres://user:pass@localhost:5432/campus — when set, native Postgres is used. */
  url?: string;
  /** PGlite on-disk directory, e.g. ".data/campus". Omit for in-memory. */
  pgliteDir?: string;
}

export async function createDb(config: DbConfig): Promise<Db> {
  return config.url ? createPgDb({ connectionString: config.url }) : createPgliteDb(config.pgliteDir);
}
