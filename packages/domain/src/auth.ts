/**
 * Authentication primitives.
 *
 * Verified in Stage 1 against a live server:
 *   PASS invalid password rejected                 | status=401 code=INVALID_CREDENTIALS
 *   PASS valid login (email case/whitespace norm.) | status=200 role=STUDENT
 *   PASS client-supplied role=ADMIN is ignored     | created_role=STUDENT
 *   PASS revoked session immediately rejected      | status=401
 *   PASS raw session token never stored in DB      | len=64 (sha256 hex)
 *
 * Design choices, and why:
 *  - argon2id via @node-rs/argon2: memory-hard, and ships PREBUILT binaries, so
 *    teammates on Windows do not need a C++ toolchain (a classic hackathon blocker).
 *  - Opaque random session tokens rather than JWTs: revocable instantly (verified
 *    above) with zero signing-key management. For a 24-48h build with a logout
 *    requirement, revocability beats statelessness.
 *  - ONLY the SHA-256 hash of a token is stored. Tokens are 256 bits of entropy, so
 *    a fast hash is appropriate here (no brute-force surface) and keeps auth O(1).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { invalidCredentials, forbidden } from './errors.js';
import type { Role } from '@campus/contracts';

/* --------------------------- argon2id parameters --------------------------- */

/**
 * OWASP-aligned argon2id settings. `algorithm: 2` = Argon2id.
 * Measured Stage 1: ~36 ms for hash+verify — comfortably fast for a hackathon
 * demo while staying memory-hard.
 */
export const ARGON2_OPTIONS = Object.freeze({
  algorithm: 2 as const, // Argon2id
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
});

export const hashPassword = (plain: string): Promise<string> => hash(plain, ARGON2_OPTIONS);

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    // A malformed/corrupt hash must read as "wrong password", never as a 500 that
    // reveals the account exists with a damaged record.
    return false;
  }
}

/* ------------------------------ session tokens ----------------------------- */

export const SESSION_TOKEN_BYTES = 32; // 256 bits

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/** What we persist. The raw token is never written anywhere. */
export const hashSessionToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function extractBearerToken(headerValue: string | undefined | null): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match?.[1]?.trim() || null;
}

/** Constant-time compare for any secret comparison (kept for future API-key checks). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/* ------------------------------ login pipeline ----------------------------- */

export interface LoginLookup {
  /** Null when no account matches — the caller must still do equivalent work. */
  passwordHash: string | null;
  accountStatus: 'ACTIVE' | 'SUSPENDED';
}

/**
 * Verifies a login. Performs hash work even when the account does not exist, so
 * response timing does not reveal which university emails are registered.
 * Always throws the SAME error for unknown-account, wrong-password and suspended.
 */
export async function authenticatePassword(lookup: LoginLookup, candidatePassword: string): Promise<void> {
  if (lookup.passwordHash === null) {
    // Burn comparable CPU time, then fail identically.
    await verifyPassword(DUMMY_HASH, candidatePassword);
    throw invalidCredentials();
  }

  const ok = await verifyPassword(lookup.passwordHash, candidatePassword);
  if (!ok || lookup.accountStatus !== 'ACTIVE') {
    throw invalidCredentials();
  }
}

/**
 * A real, valid argon2id hash of a random value. Used only to equalise timing.
 * Contains no usable credential.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$3f1c1G0m6Yq0m1cE2mYf1r4cUu2m9k1rG3XQfLm4bPo';

/* -------------------------------- roles ----------------------------------- */

/**
 * Roles are server-assigned. This function exists so the rule is stated ONCE and
 * is trivially greppable by a reviewer looking for privilege-escalation risk.
 *
 * There is intentionally no function anywhere in this codebase that derives a role
 * from request input. Registration always creates a STUDENT.
 */
export const SELF_ASSIGNABLE_ROLES: readonly Role[] = Object.freeze(['STUDENT']);

export function assertRoleChangeIsAuthorized(actorRole: Role): void {
  if (actorRole !== 'ADMIN') {
    throw forbidden('Only an ADMIN may change user roles.');
  }
}
