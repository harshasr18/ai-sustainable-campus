/**
 * Serves the BUILT web client (apps/web/dist) from the API process.
 *
 * WHY THIS EXISTS. In development the Vite dev server serves the website and proxies
 * `/v1/*` to the API. A hosted deployment has no Vite server, so the API serves the
 * compiled files itself. The browser still calls relative `/v1/...` paths, so the client
 * code needs no change and no CORS configuration.
 *
 * Only active when SERVE_WEB=true AND apps/web/dist/index.html exists.
 *
 * Rules:
 *  - `/v1/*` and `/healthz` that match no route still return the normal JSON 404.
 *  - A real file under dist (JS, CSS, images) is served as-is.
 *  - Any other GET is answered with index.html so client-side routes such as /login work
 *    on a hard refresh.
 *  - Path traversal is refused: the resolved path must stay inside dist.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
};

/** Returns `false` when the request is not a website request (API path or non-GET). */
export type WebFallback = (request: FastifyRequest, reply: FastifyReply) => FastifyReply | false;

/**
 * Builds the website fallback, or null when dist has not been built.
 * It is passed to registerErrorHandler, because Fastify allows only ONE not-found
 * handler and the API's JSON 404 already lives there.
 */
export function createWebFallback(distDir: string): WebFallback | null {
  const root = path.resolve(distDir);
  const indexFile = path.join(root, 'index.html');
  if (!existsSync(indexFile)) return null;

  return (request, reply) => {
    const rawPath = (request.raw.url ?? '/').split('?')[0] ?? '/';
    const isApi = rawPath.startsWith('/v1/') || rawPath === '/v1' || rawPath === '/healthz';
    if (isApi || (request.method !== 'GET' && request.method !== 'HEAD')) return false;

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return reply.code(400).send('Bad request');
    }

    const candidate = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
    const insideRoot = candidate === root || candidate.startsWith(root + path.sep);
    const isFile = insideRoot && existsSync(candidate) && statSync(candidate).isFile();

    if (isFile) {
      const ext = path.extname(candidate).toLowerCase();
      reply.header('content-type', MIME[ext] ?? 'application/octet-stream');
      // Vite fingerprints files under /assets/, so they can be cached for a long time.
      reply.header(
        'cache-control',
        decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      );
      return reply.send(createReadStream(candidate));
    }

    reply.header('content-type', MIME['.html']!);
    reply.header('cache-control', 'no-cache');
    return reply.send(createReadStream(indexFile));
  };
}
