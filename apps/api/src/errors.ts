/**
 * Central error mapping.
 *
 * One convention for every endpoint (brief Section 11 + 13). Clients get a stable
 * `code` from the shared contract plus a human message; they never receive a stack
 * trace, a SQL error, a constraint name, or any internal detail.
 *
 * Internal faults are logged in full server-side and returned as a generic
 * INTERNAL_ERROR carrying only the request id, so a judge-facing demo can never
 * leak a stack trace while the team retains full debuggability from the logs.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { DomainError } from '@campus/domain';

export function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  code: string,
  message: string,
  httpStatus: number,
  details?: { path: string; message: string }[],
): FastifyReply {
  return reply.code(httpStatus).send({
    error: {
      code,
      message,
      ...(details && details.length ? { details } : {}),
      requestId: request.id,
    },
  });
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    // 1. Business/domain failures — deliberate, specific, safe to show.
    if (err instanceof DomainError) {
      request.log.info(
        { err: err.code, status: err.httpStatus, path: request.url },
        `domain error: ${err.message}`,
      );
      return sendError(reply, request, err.code, err.message, err.httpStatus, err.details);
    }

    // 2. Request validation failures (Zod, thrown by the type provider).
    if (err instanceof ZodError || (err as { name?: string }).name === 'ZodError') {
      const issues = (err as ZodError).issues ?? [];
      return sendError(
        reply,
        request,
        'VALIDATION_FAILED',
        'The request body or parameters are invalid.',
        400,
        issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      );
    }

    // 3. Fastify's own validation/serialization errors.
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    if (statusCode === 400) {
      return sendError(reply, request, 'VALIDATION_FAILED', 'The request could not be processed.', 400);
    }
    if (statusCode === 401) {
      return sendError(reply, request, 'UNAUTHENTICATED', 'Authentication required.', 401);
    }
    if (statusCode === 403) {
      return sendError(reply, request, 'FORBIDDEN', 'You do not have permission to perform this action.', 403);
    }
    if (statusCode === 404) {
      return sendError(reply, request, 'NOT_FOUND', 'Resource not found.', 404);
    }
    if (statusCode === 413) {
      return sendError(reply, request, 'PAYLOAD_TOO_LARGE', 'The uploaded photo is too large.', 413);
    }
    if (statusCode === 415) {
      return sendError(reply, request, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported request content type.', 415);
    }
    if (statusCode === 429) {
      return sendError(reply, request, 'RATE_LIMITED', 'Too many requests. Please slow down.', 429);
    }

    // 4. Anything else is an internal fault. Log everything, tell the client nothing.
    request.log.error({ err, path: request.url, method: request.method }, 'unhandled error');
    return sendError(reply, request, 'INTERNAL_ERROR', 'An unexpected error occurred. Please try again.', 500);
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(reply, request, 'NOT_FOUND', `No route matches ${request.method} ${request.url}.`, 404),
  );
}
