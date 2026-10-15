/**
 * Data-fetching hook.
 *
 * Small on purpose — no caching library. The app has a handful of pages each fetching one
 * or two endpoints, and a query-cache dependency would be more machinery than the problem
 * needs. What it does provide is the part that is easy to get wrong:
 *
 *   - explicit loading / error / empty states, so no page can forget one;
 *   - cancellation on unmount, so a slow request cannot set state on a dead component
 *     (which is how a "can't perform a React state update on an unmounted component"
 *     warning, and a genuine memory leak, happen);
 *   - a `reload()` the UI can wire to a Retry button, because a network error must always
 *     be recoverable without a full page refresh;
 *   - `keepPreviousData` while reloading, so filtering a table does not blank it out.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api.js';

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** True while a reload is in flight and stale data is still on screen. */
  refreshing: boolean;
  reload: () => void;
}

export function useAsync<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);
  const hasLoadedOnce = useRef(false);

  // The fetcher is usually an inline arrow function, so its identity changes every render.
  // Holding it in a ref keeps it out of the dependency list — callers declare their real
  // dependencies in `deps`, which is what actually decides when to refetch.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    if (hasLoadedOnce.current) setRefreshing(true);
    else setLoading(true);

    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({
                code: 'INTERNAL_ERROR',
                message: caught instanceof Error ? caught.message : 'Something went wrong.',
                status: 0,
              }),
        );
      })
      .finally(() => {
        if (cancelled) return;
        hasLoadedOnce.current = true;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, refreshing, reload };
}

/**
 * Wraps a one-shot mutation (submit, approve, resolve) with pending/error state and
 * double-submit protection.
 *
 * The `pending` guard is not cosmetic: submitting a report twice creates two reports, so
 * "disable the button while in flight" is a correctness requirement, not a nicety. It is
 * still only a client-side guard — the backend's idempotency is what makes it safe — but
 * both belong.
 */
export interface MutationState<TArgs extends unknown[], TResult> {
  run: (...args: TArgs) => Promise<TResult | null>;
  pending: boolean;
  error: ApiError | null;
  reset: () => void;
}

export function useMutation<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
): MutationState<TArgs, TResult> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const pendingRef = useRef(false);

  const run = useCallback(
    async (...args: TArgs): Promise<TResult | null> => {
      if (pendingRef.current) return null; // ignore a second tap mid-flight
      pendingRef.current = true;
      setPending(true);
      setError(null);
      try {
        return await action(...args);
      } catch (caught) {
        const apiError =
          caught instanceof ApiError
            ? caught
            : new ApiError({
                code: 'INTERNAL_ERROR',
                message: caught instanceof Error ? caught.message : 'Something went wrong.',
                status: 0,
              });
        setError(apiError);
        return null;
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [action],
  );

  const reset = useCallback(() => setError(null), []);

  return { run, pending, error, reset };
}
