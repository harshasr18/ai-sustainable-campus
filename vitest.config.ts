import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // PGlite boots a real PostgreSQL engine and applies 6 migrations per test file,
    // so the first assertion in a file can legitimately take a few seconds.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Run test FILES sequentially, but give each file its OWN process.
    // `singleFork: true` shared one process across all six files, which let
    // leaked engine handles from one file cut the tail off another (observed as
    // non-deterministic `skipped` tests). One fresh process per file is more
    // robust and still avoids memory contention, since files never overlap.
    pool: 'forks',
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
