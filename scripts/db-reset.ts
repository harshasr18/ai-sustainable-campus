#!/usr/bin/env node
/**
 * Database rebuild:  npm run db:reset
 *
 * WHAT THIS IS FOR. A local development or DEMO database sometimes has to be thrown
 * away and rebuilt: it was snapshotted mid-write and will not open, a migration was
 * being tested, or the demo needs to start from a known state before judges arrive.
 * Doing that by hand — find the directory, rm -rf it, remember to migrate, remember
 * to seed — is exactly the kind of undocumented manual step that turns into a
 * five-minute panic in front of an audience.
 *
 * WHAT IT DELIBERATELY WILL NOT DO.
 *
 *   - It will not run when NODE_ENV=production.
 *   - It will not touch a remote database. DATABASE_URL must be absent or a loopback
 *     address; anything else is refused before a single statement is issued.
 *   - It will not delete a directory that is not recognisably a PGlite cluster. If
 *     the configured path contains something else, the script stops and says what it
 *     found rather than removing it. A reset script that can be pointed at the wrong
 *     path is a loaded gun.
 *   - It does not touch `storage/evidence/`. Student photographs live there, are not
 *     part of the database, and are not this script's to discard. Removing the rows
 *     that reference them is already destructive enough.
 *
 * Usage:
 *   npm run db:reset              rebuild, migrate and seed campus data
 *   npm run db:reset -- --dry-run  report what would happen, change nothing
 *   npm run db:reset -- --keep     keep the old data directory (renamed .unreadable)
 */

import { existsSync, readdirSync, readFileSync, rmSync, renameSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createDb, type DbConfig } from '../packages/db/src/driver.js';
import { runMigrations } from '../packages/db/src/migrate.js';
import { seedAll } from '../packages/db/src/seed.js';
import { loadConfig, loadDotEnv } from '../packages/db/src/env.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const keepOld = args.has('--keep');

/** Loopback only. A name like `db` or a private IP is NOT accepted. */
function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Decides whether a directory is safe to delete.
 *
 * "Safe" means: it is empty, or it looks like a PostgreSQL cluster. The marker is
 * `PG_VERSION`, which initdb writes and nothing else ever produces. Anything else in
 * the directory means the path is probably not what the operator thought it was.
 */
function classifyDirectory(dir: string): { kind: 'absent' | 'empty' | 'cluster' | 'foreign'; contents: string[] } {
  if (!existsSync(dir)) return { kind: 'absent', contents: [] };
  const contents = readdirSync(dir);
  if (contents.length === 0) return { kind: 'empty', contents };
  if (contents.includes('PG_VERSION')) return { kind: 'cluster', contents };
  return { kind: 'foreign', contents };
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  console.log('Database rebuild (npm run db:reset)');
  console.log('──────────────────────────────────────────────────────────────');

  /* ---------------------------------------------------------------- */
  /* Guard 1 — never in production                                     */
  /* ---------------------------------------------------------------- */
  if (config.nodeEnv === 'production') {
    console.error('REFUSED: NODE_ENV=production. This script destroys data and is for');
    console.error('         local development and demonstration only.');
    process.exitCode = 1;
    return;
  }

  /* ---------------------------------------------------------------- */
  /* Guard 2 — never against a remote database                         */
  /* ---------------------------------------------------------------- */
  if (config.databaseUrl && !isLoopback(config.databaseUrl)) {
    console.error('REFUSED: DATABASE_URL does not point at this machine.');
    console.error(`         Host: ${new URL(config.databaseUrl).host}`);
    console.error('         This script only rebuilds a LOCAL database.');
    process.exitCode = 1;
    return;
  }

  const pgliteDir = resolve(config.pgliteDir ?? '.data/campus');
  const usingNative = Boolean(config.databaseUrl);

  console.log(`Mode              : ${usingNative ? 'native PostgreSQL (local)' : 'PGlite'}`);
  console.log(`Location          : ${usingNative ? config.databaseUrl : pgliteDir}`);
  console.log(`Evidence          : ${resolve(config.evidenceDir)}  (NOT touched)`);
  console.log('');

  if (!usingNative) {
    const { kind, contents } = classifyDirectory(pgliteDir);

    if (kind === 'foreign') {
      console.error('REFUSED: that directory exists but does not look like a PGlite cluster');
      console.error('         (no PG_VERSION file). It contains:');
      for (const entry of contents.slice(0, 10)) console.error(`           ${entry}`);
      console.error('');
      console.error('         Nothing has been deleted. Check PGLITE_DIR in .env.');
      process.exitCode = 1;
      return;
    }

    if (kind === 'cluster') {
      const version = readFileSync(join(pgliteDir, 'PG_VERSION'), 'utf8').trim();
      const sizeMb = Math.round(directorySize(pgliteDir) / 1024 / 1024);
      console.log(`Found a cluster  : PostgreSQL ${version}, ~${sizeMb} MB, to be discarded`);
    } else {
      console.log(`Found            : ${kind === 'absent' ? 'no directory' : 'an empty directory'} — nothing to discard`);
    }

    if (dryRun) {
      console.log('');
      console.log('DRY RUN — nothing was changed. Re-run without --dry-run to proceed.');
      return;
    }

    if (kind === 'cluster') {
      if (keepOld) {
        const backup = `${pgliteDir}.unreadable`;
        rmSync(backup, { recursive: true, force: true });
        renameSync(pgliteDir, backup);
        console.log(`Kept old cluster : moved to ${backup}`);
      } else {
        rmSync(pgliteDir, { recursive: true, force: true });
        console.log('Discarded        : old cluster removed');
      }
    }
  } else if (dryRun) {
    console.log('DRY RUN — nothing was changed. Re-run without --dry-run to drop and rebuild.');
    return;
  }

  /* ---------------------------------------------------------------- */
  /* Rebuild                                                           */
  /* ---------------------------------------------------------------- */
  const dbConfig: DbConfig = config.databaseUrl
    ? { url: config.databaseUrl }
    : { pgliteDir: config.pgliteDir ?? '.data/campus' };
  const db = await createDb(dbConfig);

  try {
    console.log(`Engine           : ${db.engine}`);

    const { applied } = await runMigrations(db);
    console.log(`Migrations       : ${applied.length} applied${applied.length ? ` -> ${applied.join(', ')}` : ''}`);

    const summary = await seedAll(db, {
      password: config.demoSeedPassword,
      includeRealAdmin: config.nodeEnv !== 'production',
    });
    console.log(`Campus data      : ${summary.blocks} blocks (REAL + DEMO), ${summary.spots} spots`);
    console.log(`Accounts         : ${summary.accountsCreated.length} created`);

    /*
     * SEPARATION IS ASSERTED, NOT ASSUMED.
     *
     * §11 requires that demo data never appears in the real workspace. The cheapest
     * way to be sure after a rebuild is to count the rows in each workspace and print
     * them: a demo workspace that is quietly non-empty, or a real workspace that has
     * picked up sample issues, is visible here rather than discovered on stage.
     */
    const counts = await db.query<{ workspace: string; issues: number; reports: number; users: number }>(
      `SELECT w.kind AS workspace,
              (SELECT count(*)::int FROM issues  i WHERE i.workspace_id = w.id) AS issues,
              (SELECT count(*)::int FROM reports r WHERE r.workspace_id = w.id) AS reports,
              (SELECT count(*)::int FROM users   u WHERE u.workspace_id = w.id) AS users
         FROM workspaces w
        ORDER BY w.kind`,
    );
    console.log('');
    console.log('Workspace separation (must stay separate — §11):');
    for (const row of counts.rows) {
      console.log(`  ${row.workspace.padEnd(6)} issues=${String(row.issues).padEnd(4)} reports=${String(row.reports).padEnd(4)} users=${row.users}`);
    }

    if (summary.generatedPassword) {
      console.log('');
      console.log('──────────────────────────────────────────────────────────────');
      console.log(' DEMO PASSWORD (generated — shown once, not stored anywhere):');
      console.log(`   ${summary.generatedPassword}`);
      console.log(' Set DEMO_SEED_PASSWORD in .env for a stable value.');
      console.log('──────────────────────────────────────────────────────────────');
    }

    console.log('');
    console.log('Rebuild complete. Start the API with:  npm start');
  } finally {
    await db.close();
  }
}

function directorySize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    try {
      const stats = statSync(path);
      if (stats.isDirectory()) total += directorySize(path);
      else total += stats.size;
    } catch {
      // A file that vanished mid-count is not worth failing the report over.
    }
  }
  return total;
}

main().catch((err: unknown) => {
  console.error('Rebuild failed:');
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
