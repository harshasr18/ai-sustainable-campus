/**
 * Authorized photograph loading.
 *
 * WHY THIS MODULE EXISTS, AND WHY `<img src>` IS WRONG HERE:
 *
 * Student photographs are private. They are stored outside any served directory and the
 * only way to read one is `GET /v1/reports/:id/evidence`, which the backend authorizes per
 * request — only the reporter, or an HOD/ADMIN in the same workspace.
 *
 * That means a plain `<img src="/v1/reports/abc/evidence">` CANNOT work: the browser would
 * make the request without the session's Authorization header, and the endpoint would
 * correctly answer 401. Thumbnails therefore have to be fetched with the session token and
 * turned into an object URL. This is the single fact that shapes every image in this app,
 * which is why it lives in one reviewed place instead of being reinvented per component.
 *
 * The cache has three responsibilities:
 *   - de-duplicate: twenty thumbnails of the same report must make one request, not twenty;
 *   - survive remounts: navigating away and back should not flicker;
 *   - release memory: object URLs are freed when nothing references them, so a long
 *     session browsing hundreds of reports does not accumulate blobs.
 *
 * NOTHING here is allowed to invent an image. A 403 (not yours), a 404 (no photo) and a
 * 500 (server problem) are three different states and are reported as such, because
 * "broken image icon" tells a user nothing useful.
 */

import { useEffect, useState } from 'react';
import { ApiError, getToken } from './api.js';

export type EvidenceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'forbidden' }
  | { status: 'missing' }
  | { status: 'error'; message: string };

interface CacheEntry {
  url: string;
  refCount: number;
  released: boolean;
}

/** reportId -> object URL. Module-level so it outlives component remounts. */
const cache = new Map<string, CacheEntry>();
/** reportId -> in-flight request, so concurrent renders share one fetch. */
const inFlight = new Map<string, Promise<string>>();

function releaseWhenIdle(reportId: string): void {
  const entry = cache.get(reportId);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    // Deferred by a tick: a route change unmounts the old view and mounts the new one in
    // the same commit, and revoking immediately would kill a URL the new view still shows.
    setTimeout(() => {
      const current = cache.get(reportId);
      if (current && current.refCount <= 0) {
        URL.revokeObjectURL(current.url);
        cache.delete(reportId);
      }
    }, 1000);
  }
}

async function fetchEvidence(reportId: string, signal?: AbortSignal): Promise<string> {
  const existing = inFlight.get(reportId);
  if (existing) return existing;

  const promise = (async () => {
    const token = getToken();
    const response = await fetch(`/v1/reports/${reportId}/evidence`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      credentials: 'same-origin',
      signal,
    });

    if (response.status === 403) throw new ApiError({ code: 'FORBIDDEN', message: '', status: 403 });
    if (response.status === 404) throw new ApiError({ code: 'NOT_FOUND', message: '', status: 404 });
    if (!response.ok) {
      throw new ApiError({
        code: 'INTERNAL_ERROR',
        message: `Photo could not be loaded (status ${response.status}).`,
        status: response.status,
      });
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    cache.set(reportId, { url, refCount: 0, released: false });
    return url;
  })();

  inFlight.set(reportId, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(reportId);
  }
}

/**
 * Fetches (or reuses) an authorized photograph for a report.
 *
 * Pass `reportId: null` to fetch nothing — used when a list row has no evidence.
 */
export function useEvidence(reportId: string | null | undefined): EvidenceState {
  const [state, setState] = useState<EvidenceState>({ status: 'idle' });

  useEffect(() => {
    if (!reportId) {
      setState({ status: 'idle' });
      return;
    }

    // Already cached: use it immediately, no request and no loading flash.
    const cached = cache.get(reportId);
    if (cached) {
      cached.refCount += 1;
      setState({ status: 'ready', url: cached.url });
      return () => releaseWhenIdle(reportId);
    }

    let cancelled = false;
    const controller = new AbortController();
    setState({ status: 'loading' });

    fetchEvidence(reportId, controller.signal)
      .then((url) => {
        if (cancelled) return;
        const entry = cache.get(reportId);
        if (entry) entry.refCount += 1;
        setState({ status: 'ready', url });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (error instanceof ApiError && error.isForbidden) {
          setState({ status: 'forbidden' });
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          setState({ status: 'missing' });
          return;
        }
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Photo could not be loaded.',
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
      releaseWhenIdle(reportId);
    };
  }, [reportId]);

  return state;
}

/** Clears every cached photo. Called on sign-out so one user's images cannot linger. */
export function clearEvidenceCache(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
  cache.clear();
  inFlight.clear();
}
