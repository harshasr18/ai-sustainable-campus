/**
 * The API client.
 *
 * DESIGN RULES, each with a reason:
 *
 * 1. ALL requests use RELATIVE URLs (`/v1/...`). The Vite dev server proxies them to the
 *    API (see vite.config.ts). Hardcoding `http://localhost:3001` would break the moment
 *    the page is opened from any machine other than the server itself, which is exactly
 *    what happens in a demo on someone else's laptop or a proxied preview.
 *
 * 2. ONE error type. The backend returns a stable envelope
 *    `{ error: { code, message, details?, requestId } }` for every failure. The client
 *    turns that into a single `ApiError`, so no component ever has to guess at a shape or
 *    read `response.status` to decide what happened.
 *
 * 3. 401 is handled in ONE place. A student sitting on an expired session should be sent
 *    back to login, not shown "Forbidden" on a page that will work after signing in again.
 *    The handler is injected rather than imported, so this module stays free of React.
 *
 * 4. The session token is held in memory plus sessionStorage — NOT localStorage. Tokens in
 *    localStorage survive a browser restart and are readable by any script on the origin.
 *    sessionStorage scopes it to the tab; the trade-off (a refresh keeps you signed in, a
 *    new tab does not) is the right one for a campus tool.
 */

import type { ErrorCode } from '@campus/contracts';

/** The shape every failure from this API takes. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode | string;
    message: string;
    details?: { path: string; message: string }[];
    requestId?: string;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: { path: string; message: string }[];
  readonly requestId: string | null;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    details?: { path: string; message: string }[];
    requestId?: string | null;
  }) {
    super(input.message);
    this.name = 'ApiError';
    this.code = input.code;
    this.status = input.status;
    this.details = input.details ?? [];
    this.requestId = input.requestId ?? null;
  }

  /** True when re-trying the same request could plausibly succeed. */
  get isRetryable(): boolean {
    return this.status >= 500 || this.code === 'RATE_LIMITED' || this.status === 0;
  }

  /** True when the user needs to sign in again. */
  get isAuthFailure(): boolean {
    return (
      this.status === 401 ||
      this.code === 'UNAUTHENTICATED' ||
      this.code === 'INVALID_SESSION' ||
      this.code === 'INVALID_CREDENTIALS'
    );
  }

  /** True when the user is signed in but not permitted — a different problem entirely. */
  get isForbidden(): boolean {
    return this.status === 403 || this.code === 'FORBIDDEN';
  }

  /** True when the feature is deliberately not implemented (e.g. AI not configured). */
  get isNotImplemented(): boolean {
    return this.status === 501 || this.code === 'NOT_IMPLEMENTED';
  }
}

/* ------------------------------------------------------------------ */
/* Session token access, kept in one place                            */
/* ------------------------------------------------------------------ */

const TOKEN_KEY = 'campus.session';

let inMemoryToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export function getToken(): string | null {
  if (inMemoryToken) return inMemoryToken;
  try {
    inMemoryToken = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // sessionStorage can throw in hardened/private browsing. Falling back to memory-only
    // is correct: the app still works, it just will not survive a refresh.
    inMemoryToken = null;
  }
  return inMemoryToken;
}

export function setToken(token: string | null): void {
  inMemoryToken = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* memory-only fallback, as above */
  }
}

/* ------------------------------------------------------------------ */
/* Core request                                                        */
/* ------------------------------------------------------------------ */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON body. Mutually exclusive with `form`. */
  body?: unknown;
  /** multipart/form-data body (report submission). Mutually exclusive with `body`. */
  form?: FormData;
  signal?: AbortSignal;
  /** Skip the global 401 handler — used by the login call itself. */
  skipAuthRedirect?: boolean;
}

function buildHeaders(options: RequestOptions): Headers {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  // Note: no Content-Type for FormData — the browser must set the multipart boundary.
  return headers;
}

async function toApiError(response: Response): Promise<ApiError> {
  let parsed: ApiErrorBody | null = null;
  try {
    parsed = (await response.json()) as ApiErrorBody;
  } catch {
    // A non-JSON body (a proxy error page, an HTML 502) must still produce a usable error.
    parsed = null;
  }
  const envelope = parsed?.error;
  return new ApiError({
    code: envelope?.code ?? (response.status === 0 ? 'NETWORK_ERROR' : 'INTERNAL_ERROR'),
    message:
      envelope?.message ??
      (response.status >= 500
        ? 'The server encountered a problem. Please try again.'
        : `Request failed with status ${response.status}.`),
    status: response.status,
    details: envelope?.details,
    requestId: envelope?.requestId ?? null,
  });
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = buildHeaders(options);

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body:
        options.form ??
        (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      signal: options.signal,
      // The session travels in an Authorization header, not a cookie, so requests are not
      // credentialed by default and no CSRF token dance is needed.
      credentials: 'same-origin',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError({
      code: 'NETWORK_ERROR',
      message:
        'Could not reach the server. Check that the API is running and that you are online.',
      status: 0,
    });
  }

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    const apiError = await toApiError(response);
    if (apiError.isAuthFailure && !options.skipAuthRedirect) {
      setToken(null);
      onUnauthorized?.();
    }
    throw apiError;
  }

  // Some endpoints legitimately return an empty body.
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Typed helpers. `get`/`post`/`patch` read better at call sites than a method string. */
export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body' | 'form'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  /** multipart/form-data — used only by report submission. */
  postForm: <T>(path: string, form: FormData, options?: Omit<RequestOptions, 'method' | 'form'>) =>
    request<T>(path, { ...options, method: 'POST', form }),
};

/** Serialises filters into a query string, dropping empty values. */
export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
