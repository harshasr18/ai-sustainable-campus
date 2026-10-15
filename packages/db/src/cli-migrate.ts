#!/usr/bin/env node
/**
 * Migration CLI:  npm run migrate
 *
 * Uses DATABASE_URL (native PostgreSQL) when present, otherwise PGlite stored in
 * PGLITE_DIR — so a teammate can run the whole stack with zero database install.
 */
import { createDb, type DbConfig } from './driver.js';
import { appliedMigrations, runMigrations } from './migrate.js';
import { loadConfig, loadDotEnv } from './env.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const dbConfig: DbConfig = config.databaseUrl
    ? { url: config.databaseUrl }
    : { pgliteDir: config.pgliteDir ?? '.data/campus' };

  const db = await createDb(dbConfig);
  try {
    const before = await appliedMigrations(db);
    const { applied, skipped } = await runMigrations(db);
    const after = await appliedMigrations(db);

    console.log(`Engine            : ${db.engine}${config.databaseUrl ? ' (native PostgreSQL)' : ` (PGlite @ ${dbConfig.pgliteDir})`}`);
    console.log(`Already applied   : ${before.length}`);
    console.log(`Newly applied     : ${applied.length}${applied.length ? ` -> ${applied.join(', ')}` : ''}`);
    console.log(`Unchanged         : ${skipped.length}`);
    console.log(`Total recorded    : ${after.length}`);
    console.log(applied.length === 0 ? 'Schema is up to date.' : 'Migration complete.');
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error('Migration failed:');
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
