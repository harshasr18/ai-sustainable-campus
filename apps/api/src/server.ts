/**
 * Server entry point:  npm run dev  /  npm start
 *
 * Boot sequence is fail-fast: configuration is validated, migrations are applied,
 * and the database is probed BEFORE the port opens. A misconfigured deployment
 * fails at startup with a clear message instead of at the first request.
 */
import { createDb, loadConfig, loadDotEnv, runMigrations, type DbConfig } from '@campus/db';
import { buildApp } from './app.js';

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

  const app = await buildApp({ db, config });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
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
