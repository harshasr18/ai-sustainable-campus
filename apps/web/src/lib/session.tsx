/**
 * Session and authorization state.
 *
 * Holds the signed-in user, the login/logout actions, and — importantly — the ROLE.
 *
 * A NOTE ON WHAT THIS IS NOT:
 * this provider is a convenience for rendering, never a security boundary. Hiding an HOD
 * link from a student is not authorization. Every protected operation is enforced by the
 * backend, the client handles the resulting 403 rather than assuming it cannot happen, and
 * §4 of the brief says so explicitly ("Hiding a button is not authorization"). The role
 * kept here only decides what to *show*.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, setToken, getToken, setUnauthorizedHandler } from './api.js';
import { clearEvidenceCache } from './evidence.js';

/** Mirrors the backend's Role and WorkspaceKind, from the shared contract. */
export type Role = 'STUDENT' | 'HOD' | 'ADMIN';
export type WorkspaceKind = 'REAL' | 'DEMO';

/**
 * Mirrors `SessionUserSchema` in @campus/contracts EXACTLY.
 *
 * Corrected during the build: an earlier draft of this interface declared `workspaceId` and
 * `department`, which `/v1/auth/me` and `/v1/auth/login` do not return. That was a type lie
 * — the fields would have been `undefined` at runtime while TypeScript insisted they were
 * strings. The server derives the workspace from the session; the client never needs its id.
 * If a field is not in the contract, it does not belong in this interface.
 */
export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  accountStatus: 'ACTIVE' | 'SUSPENDED';
  workspace: WorkspaceKind;
}

export interface LoginResponse {
  accessToken: string;
  expiresAt: string;
  user: SessionUser;
}

interface SessionContextValue {
  user: SessionUser | null;
  /** True until the initial "am I signed in?" check finishes. Prevents a login flash. */
  initialising: boolean;
  signIn: (email: string, password: string) => Promise<SessionUser>;
  signOut: () => Promise<void>;
  /** Called by the API client when the server rejects the session. */
  onSessionLost: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [initialising, setInitialising] = useState(true);

  /**
   * Verifies a stored token against the server on boot.
   *
   * WHY NOT DECODE THE TOKEN LOCALLY: it is an opaque random string, deliberately not a
   * JWT — the Phase 1 design chose server-side sessions so a token can be revoked
   * instantly. So the only way to know whether a session is still valid is to ask.
   */
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      if (!getToken()) {
        if (!cancelled) setInitialising(false);
        return;
      }
      try {
        const me = await api.get<{ user: SessionUser }>('/v1/auth/me', { skipAuthRedirect: true });
        if (!cancelled) setUser(me.user);
      } catch {
        // Expired or revoked: drop it silently and show the login screen.
        setToken(null);
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setInitialising(false);
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  /** The API client calls this when any request returns 401. */
  const onSessionLost = useCallback(() => {
    setUser(null);
    clearEvidenceCache();
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(onSessionLost);
    return () => setUnauthorizedHandler(null);
  }, [onSessionLost]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api.post<LoginResponse>(
      '/v1/auth/login',
      { email, password },
      // The login request itself must not trigger the global redirect-on-401 handler;
      // a wrong password is a normal outcome shown inline in the form.
      { skipAuthRedirect: true },
    );
    setToken(result.accessToken);
    setUser(result.user);
    return result.user;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/v1/auth/logout');
    } catch (error) {
      // A failed logout must still log the user out locally. Leaving someone signed in
      // because the network blipped is worse than an unrevoked server-side session.
      if (!(error instanceof ApiError)) throw error;
    }
    setToken(null);
    clearEvidenceCache();
    setUser(null);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ user, initialising, signIn, signOut, onSessionLost }),
    [user, initialising, signIn, signOut, onSessionLost],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>.');
  return context;
}

/** The signed-in user, or a thrown error if used outside a guarded route. */
export function useCurrentUser(): SessionUser {
  const { user } = useSession();
  if (!user) throw new Error('useCurrentUser used outside an authenticated route.');
  return user;
}

/**
 * Route access rules, in ONE table.
 *
 * Both the router guard and the navigation menu read from this, so a page can never appear
 * in the sidebar for a role that is not allowed to open it — the two cannot drift.
 */
export const ROUTE_ACCESS: Record<string, Role[]> = {
  '/student': ['STUDENT'],
  '/student/report': ['STUDENT'],
  '/student/reports': ['STUDENT'],
  '/student/tokens': ['STUDENT'],
  '/hod': ['HOD', 'ADMIN'],
  '/hod/issues': ['HOD', 'ADMIN'],
  '/hod/review': ['HOD', 'ADMIN'],
  '/admin': ['ADMIN'],
  '/admin/issues': ['ADMIN', 'HOD'],
  '/admin/twin': ['ADMIN'],
  '/admin/analytics': ['ADMIN'],
  '/admin/accounts': ['ADMIN'],
  '/admin/campus': ['ADMIN'],
  '/admin/categories': ['ADMIN'],
  '/admin/system': ['ADMIN'],
};

export function canAccess(path: string, role: Role): boolean {
  const allowed = ROUTE_ACCESS[path];
  if (!allowed) return true; // Unlisted routes (profile, shared details) are open to any signed-in user.
  return allowed.includes(role);
}

/** The landing page for a role after sign-in. */
export function homePathFor(role: Role): string {
  if (role === 'STUDENT') return '/student';
  if (role === 'HOD') return '/hod';
  return '/admin';
}
