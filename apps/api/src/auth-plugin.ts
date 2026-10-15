/**
 * Session authentication + role authorization, enforced SERVER-SIDE on every
 * protected route.
 *
 * There is no client-side role check anywhere in the system, and none is trusted.
 * A route declares who may call it; the server resolves the session from the
 * Authorization header, loads the user from the database, and rejects the request
 * before the handler runs.
 *
 * The workspace the caller may touch is derived from their SESSION, never from a
 * request body, query string, or header. That is the core of demo/real isolation.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { extractBearerToken, hashSessionToken, invalidSession, type Role } from '@campus/domain';
import { sessions as sessionRepo, type Db } from '@campus/db';

export interface AuthedActor {
  userId: string;
  role: Role;
  displayName: string;
  email: string;
  /** Server-derived. The ONLY workspace this request may read or write. */
  workspaceId: string;
  workspaceKind: 'REAL' | 'DEMO';
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: AuthedActor;
  }
}

export interface AuthOptions {
  db: Db;
}

/**
 * Returns a preHandler that authenticates the caller and optionally restricts roles.
 * Usage:  { preHandler: requireAuth(db) }              -> any authenticated user
 *         { preHandler: requireAuth(db, 'HOD','ADMIN') } -> workflow operators only
 */
export function requireAuth(db: Db, ...allowedRoles: Role[]) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      return sendUnauthenticated(reply, request);
    }

    const session = await sessionRepo.resolve(db, hashSessionToken(token));
    if (!session) {
      // Covers: unknown token, revoked (logged out), expired, or suspended account.
      return sendUnauthenticated(reply, request, 'INVALID_SESSION');
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(session.role as Role)) {
      request.log.warn(
        { userId: session.id, role: session.role, path: request.url, required: allowedRoles },
        'authorization denied',
      );
      reply.code(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'You do not have permission to perform this action.',
          requestId: request.id,
        },
      });
      return;
    }

    request.actor = {
      userId: session.id,
      role: session.role as Role,
      displayName: session.display_name,
      email: session.normalized_email,
      workspaceId: session.workspace_id,
      workspaceKind: session.workspace_kind,
      sessionId: session.session_id,
    };
  };
}

function sendUnauthenticated(reply: FastifyReply, request: FastifyRequest, code: 'UNAUTHENTICATED' | 'INVALID_SESSION' = 'UNAUTHENTICATED') {
  reply.code(401).send({
    error: {
      code,
      message: code === 'INVALID_SESSION' ? 'Your session is invalid or has expired. Please sign in again.' : 'Authentication required.',
      requestId: request.id,
    },
  });
}

/** Narrow helper so handlers get a non-optional actor after `requireAuth`. */
export function actorOf(request: FastifyRequest): AuthedActor {
  if (!request.actor) {
    // Reaching here means a route forgot its preHandler — a programming error, and
    // failing closed is the only safe response.
    throw invalidSession('No authenticated actor on request. Route is missing requireAuth().');
  }
  return request.actor;
}
