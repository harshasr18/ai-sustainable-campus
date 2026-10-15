/**
 * Phase 1 acceptance criteria #1, #2, #3, #4 — plus session hygiene and throttling.
 *
 * Every test drives the REAL HTTP stack against a REAL PostgreSQL engine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSessionToken } from '@campus/domain';
import { auth, createTestContext, errorCode, secondAppOverSharedDb, TEST_PASSWORD, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.cleanup();
});

describe('Criterion 1 — a valid user can authenticate', () => {
  it('signs in with correct credentials and returns a session', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'student@demo.dsu.edu.in', password: TEST_PASSWORD },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.accessToken.length).toBeGreaterThan(30);
    expect(body.user.role).toBe('STUDENT');
    expect(body.user.workspace).toBe('DEMO');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('normalizes email case and whitespace BEFORE validation (mobile keyboard reality)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      // Exactly what a phone keyboard produces: a stray space and autocapitalisation.
      payload: { email: '  Student@DEMO.DSU.edu.in  ', password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('student@demo.dsu.edu.in');
  });

  it('resolves the current user from the session (GET /v1/auth/me)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: auth(ctx.tokens.student),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('STUDENT');
  });
});

describe('Criterion 2 — an invalid password is rejected', () => {
  it('rejects a wrong password with 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'student@demo.dsu.edu.in', password: 'definitely-not-the-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('INVALID_CREDENTIALS');
  });

  it('returns the SAME error for an unknown account (no user enumeration)', async () => {
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@dsu.edu.in', password: 'definitely-not-the-password' },
    });
    const wrongPassword = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'student@demo.dsu.edu.in', password: 'definitely-not-the-password' },
    });

    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.code).toBe(wrongPassword.json().error.code);
    expect(unknown.json().error.message).toBe(wrongPassword.json().error.message);
  });

  it('rejects a suspended account with the same generic error', async () => {
    await ctx.db.query(`UPDATE users SET account_status = 'SUSPENDED' WHERE normalized_email = 'student2@demo.dsu.edu.in'`);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'student2@demo.dsu.edu.in', password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('INVALID_CREDENTIALS');
    await ctx.db.query(`UPDATE users SET account_status = 'ACTIVE' WHERE normalized_email = 'student2@demo.dsu.edu.in'`);
  });

  it('rejects a malformed request before it reaches the handler', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'not-an-email', password: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
  });
});

describe('Criterion 3 — an unauthorized user cannot access protected endpoints', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/tokens/balance' });
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('UNAUTHENTICATED');
  });

  it('rejects a garbage bearer token', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/tokens/balance',
      headers: auth('not-a-real-token'),
    });
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('INVALID_SESSION');
  });

  it('rejects a session AFTER logout — revocation is immediate', async () => {
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'student@demo.dsu.edu.in', password: TEST_PASSWORD },
    });
    const token = login.json().accessToken;

    const before = await ctx.app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    expect(before.statusCode).toBe(200);

    const logout = await ctx.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: auth(token) });
    expect(logout.statusCode).toBe(200);
    expect(logout.json().sessionRevoked).toBe(true);

    const after = await ctx.app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    expect(after.statusCode).toBe(401);
  });

  it('never stores the raw session token in the database', async () => {
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'student@demo.dsu.edu.in', password: TEST_PASSWORD },
    });
    const raw = login.json().accessToken as string;

    const stored = await ctx.db.query<{ token_hash: string }>(`SELECT token_hash FROM sessions`);
    expect(stored.rows.some((r) => r.token_hash === raw)).toBe(false);

    const expected = stored.rows.find((r) => r.token_hash === hashSessionToken(raw));
    expect(expected).toBeDefined();
    expect(expected!.token_hash).toHaveLength(64); // sha256 hex
  });
});

describe('Criterion 4 — a student cannot grant themselves elevated privileges', () => {
  it('ignores a client-supplied role during registration and creates a STUDENT', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'sneaky@dsu.edu.in',
        password: 'Attacker#Passw0rd',
        displayName: 'Sneaky',
        // Attempted privilege escalation — must be ignored entirely.
        role: 'ADMIN',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('STUDENT');

    const row = await ctx.db.query<{ role: string }>(
      `SELECT role FROM users WHERE normalized_email = 'sneaky@dsu.edu.in'`,
    );
    expect(row.rows[0]!.role).toBe('STUDENT');
  });

  it('denies a STUDENT access to admin-only endpoints', async () => {
    for (const url of ['/v1/admin/users', '/v1/admin/audit', '/v1/admin/outbox']) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: auth(ctx.tokens.student) });
      expect(res.statusCode, `${url} must be denied to STUDENT`).toBe(403);
      expect(errorCode(res)).toBe('FORBIDDEN');
    }
  });

  it('denies a STUDENT the ability to change any role, including their own', async () => {
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(ctx.tokens.student) });
    const myId = me.json().user.id;

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${myId}/role`,
      headers: auth(ctx.tokens.student),
      payload: { role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(403);

    const row = await ctx.db.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [myId]);
    expect(row.rows[0]!.role).toBe('STUDENT');
  });

  it('prevents an ADMIN from changing their own role (no self-elevation path)', async () => {
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(ctx.tokens.admin) });
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${me.json().user.id}/role`,
      headers: auth(ctx.tokens.admin),
      payload: { role: 'STUDENT' },
    });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
  });

  it('allows an ADMIN to change ANOTHER user role, and audits it', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/admin/users', headers: auth(ctx.tokens.admin) });
    const target = list.json().items.find((u: { email: string }) => u.email === 'student2@demo.dsu.edu.in');

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${target.id}/role`,
      headers: auth(ctx.tokens.admin),
      payload: { role: 'HOD' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('HOD');

    const auditRow = await ctx.db.query(
      `SELECT action, before_state, after_state FROM audit_log WHERE action = 'user.role_changed' AND entity_id = $1`,
      [target.id],
    );
    expect(auditRow.rows).toHaveLength(1);
    expect(auditRow.rows[0]!.after_state).toMatchObject({ role: 'HOD' });

    // Restore for other tests.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${target.id}/role`,
      headers: auth(ctx.tokens.admin),
      payload: { role: 'STUDENT' },
    });
  });
});

describe('Login throttling (brief Section 10)', () => {
  it('rejects excessive login attempts with 429', async () => {
    // A second APP over the shared database with a deliberately tiny limit, so
    // throttling is PROVEN rather than merely configured (and no extra engine is
    // booted, which previously caused the worker to be OOM-killed).
    const app = await secondAppOverSharedDb(ctx, { loginRateLimitMax: 3 });
    try {
      const attempt = () =>
        app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: 'student@demo.dsu.edu.in', password: 'wrong-password-here' },
        });

      const codes: number[] = [];
      for (let i = 0; i < 6; i += 1) codes.push((await attempt()).statusCode);

      expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

describe('Health check (brief Section 13)', () => {
  it('reports database connectivity', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.database.ok).toBe(true);
    expect(body.database.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
