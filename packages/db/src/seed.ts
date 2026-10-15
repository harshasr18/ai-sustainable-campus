/**
 * Development seeding.
 *
 * SECURITY (brief Section 10):
 *  - No password is ever hardcoded in source.
 *  - The demo password comes from DEMO_SEED_PASSWORD in a git-ignored .env.
 *  - If that is absent, a cryptographically random password is generated, shown
 *    ONCE on stdout, and never persisted to source control.
 *  - Demo accounts live in the DEMO workspace and structurally cannot read REAL data.
 */
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import type { Db, Tx } from './driver.js';
import { SEED_BLOCKS } from './seed-data.js';

export interface SeedSummary {
  workspaces: string[];
  blocks: number;
  spots: number;
  accountsCreated: { email: string; role: string; workspace: string }[];
  generatedPassword?: string;
}

/** Accessible, non-secret demo password where the operator supplied none. */
function generateDemoPassword(): string {
  return `Demo-${randomBytes(9).toString('base64url')}!`;
}

/**
 * Guards against the silent-truncation trap this project actually hit:
 * `.env` parsing treats an unquoted '#' as a comment, so
 * `DEMO_SEED_PASSWORD=CampusDemo#2026` becomes `CampusDemo` and every login fails
 * with an unexplained 401. A short or truncated password must be loud, not silent.
 */
function assertUsableDemoPassword(password: string, supplied: boolean): void {
  if (!supplied) return;
  if (password.length < 10) {
    throw new Error(
      `DEMO_SEED_PASSWORD is only ${password.length} characters. If it contains '#' or spaces, ` +
        'wrap it in QUOTES in .env — an unquoted # is parsed as the start of a comment and ' +
        'silently truncates the value.',
    );
  }
  if (password.endsWith(' ') || password.includes('  ')) {
    throw new Error('DEMO_SEED_PASSWORD appears to contain stray whitespace. Check the quoting in .env.');
  }
}

async function workspaceIdByKind(db: Db | Tx, kind: 'REAL' | 'DEMO'): Promise<string> {
  const r = await db.query<{ id: string }>(`SELECT id FROM workspaces WHERE kind = $1`, [kind]);
  if (r.rows.length === 0) {
    throw new Error(`Workspace "${kind}" is missing — run migrations before seeding (npm run migrate).`);
  }
  return r.rows[0]!.id;
}

/**
 * Campus blocks + spots are REFERENCE data, so they are seeded into both
 * workspaces: the demo must be fully self-contained without ever touching real
 * records, and the real workspace needs the same picker for go-live.
 */
export async function seedCampusReferenceData(db: Db): Promise<{ blocks: number; spots: number }> {
  let blocks = 0;
  let spots = 0;

  for (const kind of ['REAL', 'DEMO'] as const) {
    const wsId = await workspaceIdByKind(db, kind);

    for (const block of SEED_BLOCKS) {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO campus_blocks (workspace_id, official_name, slug, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, slug) DO UPDATE SET official_name = EXCLUDED.official_name, updated_at = now()
         RETURNING id`,
        [wsId, block.officialName, block.slug, block.description],
      );
      const blockId = inserted.rows[0]!.id;
      blocks += 1;

      for (const spot of block.spots) {
        const spotRow = await db.query<{ id: string }>(
          `INSERT INTO campus_spots
             (workspace_id, block_id, official_name, floor_label, area_label, latitude, longitude)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (block_id, official_name) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [
            wsId,
            blockId,
            spot.officialName,
            spot.floorLabel ?? null,
            spot.areaLabel ?? null,
            spot.latitude ?? block.latitude,
            spot.longitude ?? block.longitude,
          ],
        );
        if (spotRow.rows.length) spots += 1;
      }
    }
  }

  return { blocks, spots };
}

export interface SeedAccountsOptions {
  /** Defaults to DEMO_SEED_PASSWORD. If neither is set a random one is generated. */
  password?: string;
  /** Also create a REAL-workspace admin for local setup work. Default true in dev. */
  includeRealAdmin?: boolean;
}

/**
 * Creates demo accounts. Roles are assigned HERE, server-side — never from any
 * client input. There is no API that grants a role.
 */
export async function seedAccounts(db: Db, options: SeedAccountsOptions = {}): Promise<SeedSummary> {
  const supplied = options.password ?? process.env.DEMO_SEED_PASSWORD;
  const generated = supplied ? undefined : generateDemoPassword();
  const password = supplied ?? generated!;

  assertUsableDemoPassword(password, Boolean(supplied));

  const demoWs = await workspaceIdByKind(db, 'DEMO');
  const realWs = await workspaceIdByKind(db, 'REAL');

  const plan: { email: string; name: string; role: 'STUDENT' | 'HOD' | 'ADMIN'; workspaceId: string; workspace: string; department?: string }[] = [
    { email: 'student@demo.dsu.edu.in', name: 'Demo Student', role: 'STUDENT', workspaceId: demoWs, workspace: 'DEMO' },
    { email: 'student2@demo.dsu.edu.in', name: 'Demo Student Two', role: 'STUDENT', workspaceId: demoWs, workspace: 'DEMO' },
    { email: 'hod@demo.dsu.edu.in', name: 'Demo HOD', role: 'HOD', workspaceId: demoWs, workspace: 'DEMO', department: 'Engineering & Computing' },
    { email: 'admin@demo.dsu.edu.in', name: 'Demo Admin', role: 'ADMIN', workspaceId: demoWs, workspace: 'DEMO' },
  ];
  if (options.includeRealAdmin !== false) {
    plan.push({ email: 'admin@dsu.edu.in', name: 'Campus Administrator', role: 'ADMIN', workspaceId: realWs, workspace: 'REAL' });
  }

  const passwordHash = await hash(password);
  const accountsCreated: SeedSummary['accountsCreated'] = [];

  for (const account of plan) {
    const email = account.email.trim().toLowerCase();
    /**
     * Re-seeding behavior, stated explicitly:
     *  - password_hash IS refreshed, because the documented workflow is "set
     *    DEMO_SEED_PASSWORD in .env, then re-seed for a predictable demo password".
     *    (Earlier this was omitted, which silently kept an old randomly generated
     *    password — a real bug caught during the end-to-end smoke test.)
     *  - role is deliberately NOT refreshed: a deliberate promotion or demotion made
     *    through the admin API must survive a re-seed. Roles are never silently reset.
     */
    const r = await db.query<{ id: string }>(
      `INSERT INTO users (workspace_id, normalized_email, display_name, password_hash, role, department)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (normalized_email) DO UPDATE
         SET display_name  = EXCLUDED.display_name,
             password_hash = EXCLUDED.password_hash,
             updated_at    = now()
       RETURNING id`,
      [account.workspaceId, email, account.name, passwordHash, account.role, account.department ?? null],
    );
    if (r.rows.length) {
      accountsCreated.push({ email, role: account.role, workspace: account.workspace });
    }
  }

  return {
    workspaces: ['REAL', 'DEMO'],
    blocks: 0,
    spots: 0,
    accountsCreated,
    generatedPassword: generated,
  };
}

/** Full seed: reference data then accounts. */
export async function seedAll(db: Db, options: SeedAccountsOptions = {}): Promise<SeedSummary> {
  const campus = await seedCampusReferenceData(db);
  const accounts = await seedAccounts(db, options);
  return { ...accounts, ...campus };
}
