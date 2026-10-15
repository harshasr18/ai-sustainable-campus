#!/usr/bin/env node
/**
 * Seed CLI:  npm run seed
 *
 * Creates campus reference data and demo accounts.
 *
 * The demo password is NEVER hardcoded. It is taken from DEMO_SEED_PASSWORD
 * (.env, git-ignored) or generated randomly and printed ONCE to this terminal.
 */
import { createDb, type DbConfig } from './driver.js';
import { seedAll } from './seed.js';
import { loadConfig, loadDotEnv } from './env.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const dbConfig: DbConfig = config.databaseUrl
    ? { url: config.databaseUrl }
    : { pgliteDir: config.pgliteDir ?? '.data/campus' };

  const db = await createDb(dbConfig);
  try {
    const summary = await seedAll(db, {
      password: config.demoSeedPassword,
      // A REAL-workspace admin is convenient locally; keep it out of production.
      includeRealAdmin: config.nodeEnv !== 'production',
    });

    console.log(`Engine          : ${db.engine}`);
    console.log(`Blocks seeded   : ${summary.blocks} (REAL + DEMO workspaces)`);
    console.log(`Spots seeded    : ${summary.spots}`);
    console.log('\nAccounts:');
    for (const account of summary.accountsCreated) {
      console.log(`  ${account.email.padEnd(30)} ${account.role.padEnd(8)} workspace=${account.workspace}`);
    }

    if (summary.generatedPassword) {
      console.log('\n──────────────────────────────────────────────────────────────');
      console.log(' DEMO PASSWORD (generated — shown once, not stored anywhere):');
      console.log(`   ${summary.generatedPassword}`);
      console.log(' Re-run with DEMO_SEED_PASSWORD set in .env for a stable value.');
      console.log('──────────────────────────────────────────────────────────────');
    } else {
      console.log(
        `\nDemo password taken from DEMO_SEED_PASSWORD (${config.demoSeedPassword?.length ?? 0} characters).`,
      );
      console.log('  If sign-in fails, check quoting: an unquoted "#" in .env starts a comment.');
    }

    console.log('\n⚠  Campus block/spot names are PLACEHOLDERS pending official data.');
    console.log('   Rename them via the admin API or packages/db/src/seed-data.ts.');
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error('Seeding failed:');
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
