/**
 * Routing and access control.
 *
 * TWO GUARDS, AND WHY BOTH EXIST:
 *
 *   `RequireSession` — you must be signed in; otherwise you are sent to /login with the
 *   intended destination remembered, so signing in returns you to where you were going.
 *
 *   `RequireRole` — your role must be allowed on this route. This uses the SAME
 *   `ROUTE_ACCESS` table the sidebar reads, so the menu and the guard cannot disagree.
 *
 * A THIRD GUARD IS NOT WRITTEN, ON PURPOSE. The client cannot enforce authorization; it can
 * only avoid offering something the server will refuse. §4 is explicit — "Hiding a button is
 * not authorization" — so every page here also handles the 403 the API may return, and no
 * page assumes that reaching it locally implies permission.
 */

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useSession, canAccess, homePathFor, type Role } from './lib/session.js';
import { AppShell } from './components/AppShell.js';
import { LoadingPane, EmptyPane } from './components/states.js';
import { LoginPage } from './pages/LoginPage.js';
import { StudentDashboard } from './pages/student/StudentDashboard.js';
import { ReportIssuePage } from './pages/student/ReportIssuePage.js';
import { MyReportsPage } from './pages/student/MyReportsPage.js';
import { ReportDetailPage } from './pages/student/ReportDetailPage.js';
import { TokensPage } from './pages/student/TokensPage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { HodDashboard } from './pages/hod/HodDashboard.js';
import { IssuesPage } from './pages/hod/IssuesPage.js';
import { IssueDetailPage } from './pages/hod/IssueDetailPage.js';
import { ReviewQueuePage } from './pages/hod/ReviewQueuePage.js';
import { AdminDashboard } from './pages/admin/AdminDashboard.js';
import { AnalyticsPage } from './pages/admin/AnalyticsPage.js';
import { AccountsPage } from './pages/admin/AccountsPage.js';
import { CampusPage } from './pages/admin/CampusPage.js';
import { CategoriesPage } from './pages/admin/CategoriesPage.js';
import { SystemPage } from './pages/admin/SystemPage.js';
import { CampusTwinPage } from './pages/admin/CampusTwinPage.js';

function RequireSession({ children }: { children: ReactNode }) {
  const { user, initialising } = useSession();
  const location = useLocation();

  // While the stored token is being verified we show the loading state, not the login page:
  // flashing a login form at an already-signed-in user on every refresh is a bug, not a
  // safety feature.
  if (initialising) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '70vh' }}>
        <LoadingPane label="Checking your session…" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}

function RequireRole({ role, children }: { role: Role[]; children: ReactNode }) {
  const { user } = useSession();
  const location = useLocation();

  if (!user) return null; // RequireSession above already handled this.
  if (role.includes(user.role)) return <>{children}</>;

  // A signed-in user on a route their role cannot use. This is a genuine dead end, so it
  // says so and offers the way out rather than pretending the page does not exist.
  return (
    <EmptyPane
      icon="🔒"
      title="This page is not available to your role"
      text={`You are signed in as ${user.role.toLowerCase()}, which does not have access to ${location.pathname}. Every request to it would also be refused by the server.`}
      action={
        <a className="btn btn--primary" href={homePathFor(user.role)}>
          Go to my dashboard
        </a>
      }
    />
  );
}

/** Wraps a page in the shell plus the role check, for a given route path. */
function Guarded({ path, children }: { path: string; children: ReactNode }) {
  return <RequireRole role={allowedRoles(path)}>{children}</RequireRole>;
}

/**
 * Reads the allowed roles for a route path. Falls back to "any signed-in user" for routes
 * deliberately open to everyone (profile, an issue detail a student owns).
 */
function allowedRoles(path: string): Role[] {
  // Try the exact path, then progressively shorter prefixes, so /admin/issues/:id inherits
  // the rule for /admin/issues without every detail route needing its own entry.
  const segments = path.split('/').filter(Boolean);
  for (let take = segments.length; take > 0; take--) {
    const candidate = `/${segments.slice(0, take).join('/')}`;
    const roles = ROUTE_ACCESS_LOOKUP(candidate);
    if (roles) return roles;
  }
  return ['STUDENT', 'HOD', 'ADMIN'];
}

function ROUTE_ACCESS_LOOKUP(path: string): Role[] | null {
  if (!canAccess(path, 'STUDENT')) {
    // The table only answers "can this role access", so ask each role in turn.
    const roles = (['STUDENT', 'HOD', 'ADMIN'] as Role[]).filter((role) => canAccess(path, role));
    return roles.length > 0 ? roles : null;
  }
  const roles = (['STUDENT', 'HOD', 'ADMIN'] as Role[]).filter((role) => canAccess(path, role));
  return roles.length > 0 ? roles : null;
}

export function App() {
  const { user, initialising } = useSession();

  return (
    <Routes>
      <Route
        path="/login"
        element={
          initialising ? (
            <div style={{ display: 'grid', placeItems: 'center', minHeight: '70vh' }}>
              <LoadingPane />
            </div>
          ) : user ? (
            <Navigate to={homePathFor(user.role)} replace />
          ) : (
            <LoginPage />
          )
        }
      />

      <Route
        element={
          <RequireSession>
            <AppShell />
          </RequireSession>
        }
      >
        {/* Default landing depends on the signed-in role. */}
        <Route index element={<RoleHome />} />

        {/* ---------------------------- Student ---------------------------- */}
        <Route
          path="/student"
          element={
            <Guarded path="/student">
              <StudentDashboard />
            </Guarded>
          }
        />
        <Route
          path="/student/report"
          element={
            <Guarded path="/student/report">
              <ReportIssuePage />
            </Guarded>
          }
        />
        <Route
          path="/student/reports"
          element={
            <Guarded path="/student/reports">
              <MyReportsPage />
            </Guarded>
          }
        />
        <Route path="/student/reports/:reportId" element={<ReportDetailPage />} />
        <Route
          path="/student/tokens"
          element={
            <Guarded path="/student/tokens">
              <TokensPage />
            </Guarded>
          }
        />

        {/* ------------------------------ HOD ------------------------------ */}
        <Route
          path="/hod"
          element={
            <Guarded path="/hod">
              <HodDashboard />
            </Guarded>
          }
        />
        <Route
          path="/hod/issues"
          element={
            <Guarded path="/hod/issues">
              <IssuesPage />
            </Guarded>
          }
        />
        <Route
          path="/hod/review"
          element={
            <Guarded path="/hod/review">
              <ReviewQueuePage />
            </Guarded>
          }
        />
        <Route path="/hod/issues/:issueId" element={<IssueDetailPage />} />

        {/* ----------------------------- Admin ----------------------------- */}
        <Route
          path="/admin"
          element={
            <Guarded path="/admin">
              <AdminDashboard />
            </Guarded>
          }
        />
        <Route
          path="/admin/issues"
          element={
            <Guarded path="/admin/issues">
              <IssuesPage />
            </Guarded>
          }
        />
        <Route path="/admin/issues/:issueId" element={<IssueDetailPage />} />
        <Route
          path="/admin/analytics"
          element={
            <Guarded path="/admin/analytics">
              <AnalyticsPage />
            </Guarded>
          }
        />
        <Route
          path="/admin/twin"
          element={
            <Guarded path="/admin/twin">
              <CampusTwinPage />
            </Guarded>
          }
        />
        <Route
          path="/admin/campus"
          element={
            <Guarded path="/admin/campus">
              <CampusPage />
            </Guarded>
          }
        />
        <Route
          path="/admin/categories"
          element={
            <Guarded path="/admin/categories">
              <CategoriesPage />
            </Guarded>
          }
        />
        <Route
          path="/admin/accounts"
          element={
            <Guarded path="/admin/accounts">
              <AccountsPage />
            </Guarded>
          }
        />
        <Route
          path="/admin/system"
          element={
            <Guarded path="/admin/system">
              <SystemPage />
            </Guarded>
          }
        />

        {/* --------------------------- Shared --------------------------- */}
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

/** Sends each role to its own landing page. */
function RoleHome() {
  const { user } = useSession();
  if (!user) return null;
  return <Navigate to={homePathFor(user.role)} replace />;
}
