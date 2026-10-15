/**
 * The application shell: sidebar, header, content container.
 *
 * Navigation is DERIVED, not hand-maintained. Each nav item names the route it points at,
 * and visibility is decided by looking that route up in `ROUTE_ACCESS` — the same table the
 * router guard uses. So it is structurally impossible for the sidebar to offer a page the
 * guard will then reject, or for a page to be reachable but invisible.
 *
 * AGAIN: this hiding is presentation only. The backend enforces every protected operation
 * regardless of what this menu shows.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useCurrentUser, useSession, canAccess, homePathFor } from '../lib/session.js';
import { WorkspaceTag } from './badges.js';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** Match nested routes (e.g. /student/reports/:id keeps "My reports" highlighted). */
  end?: boolean;
}

interface NavGroup {
  heading: string;
  items: NavItem[];
}

const ICONS = {
  overview: 'M3 12l9-9 9 9M5 10v10h14V10',
  report: 'M12 5v14M5 12h14',
  list: 'M4 6h16M4 12h16M4 18h10',
  coins: 'M12 3v18M8 7h6a3 3 0 010 6H8h7a3 3 0 010 6H8',
  inbox: 'M4 13h4l2 3h4l2-3h4M4 13V6a1 1 0 011-1h14a1 1 0 011 1v7m0 0v5a1 1 0 01-1 1H5a1 1 0 01-1-1v-5',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3a15 15 0 010 18 15 15 0 010-18',
  users: 'M17 20v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM22 20v-2a4 4 0 00-3-3.87',
  building: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5',
  tag: 'M20.6 13.4L12 22l-9-9V3h10l7.6 7.6a2 2 0 010 2.8zM7.5 7.5h.01',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
} as const;

function navGroupsFor(role: 'STUDENT' | 'HOD' | 'ADMIN'): NavGroup[] {
  const groups: NavGroup[] = [];
  const allowed = (to: string) => canAccess(to, role);

  if (role === 'STUDENT') {
    const items: NavItem[] = [
      { to: '/student', label: 'Overview', icon: ICONS.overview, end: true },
      { to: '/student/report', label: 'Report an issue', icon: ICONS.report },
      { to: '/student/reports', label: 'My reports', icon: ICONS.list },
      { to: '/student/tokens', label: 'My tokens', icon: ICONS.coins },
    ].filter((item) => allowed(item.to));
    if (items.length) groups.push({ heading: 'Student', items });
  }

  if (role === 'HOD' || role === 'ADMIN') {
    const items: NavItem[] = [
      { to: role === 'HOD' ? '/hod' : '/admin', label: 'Overview', icon: ICONS.overview, end: true },
      { to: '/admin/issues', label: 'Issues', icon: ICONS.inbox },
      { to: '/hod/review', label: 'Needs review', icon: ICONS.tag },
      { to: '/admin/analytics', label: 'Analytics', icon: ICONS.chart },
    ].filter((item) => allowed(item.to));
    if (items.length) groups.push({ heading: role === 'HOD' ? 'Operations' : 'Campus', items });
  }

  if (role === 'ADMIN') {
    const items: NavItem[] = [
      { to: '/admin/twin', label: 'Campus digital twin', icon: ICONS.globe },
      { to: '/admin/campus', label: 'Blocks & spots', icon: ICONS.building },
      { to: '/admin/categories', label: 'Categories', icon: ICONS.tag },
      { to: '/admin/accounts', label: 'Accounts', icon: ICONS.users },
      { to: '/admin/system', label: 'System & audit', icon: ICONS.server },
    ].filter((item) => allowed(item.to));
    if (items.length) groups.push({ heading: 'Administration', items });
  }

  if (role === 'STUDENT') {
    // A student still has private pages that are not role-gated by path pattern.
    groups.push({
      heading: 'Account',
      items: [{ to: '/profile', label: 'Profile', icon: ICONS.users }],
    });
  }

  return groups;
}

/**
 * Header titles per route prefix, longest match wins.
 * Kept as data so adding a page is one line, and so the title can never disagree with the
 * page it labels.
 */
const PAGE_TITLES: [string, string][] = [
  ['/student/report', 'Report an issue'],
  ['/student/reports', 'My reports'],
  ['/student/tokens', 'My tokens'],
  ['/student', 'Overview'],
  ['/hod/review', 'Needs review'],
  ['/hod/issues', 'Campus issues'],
  ['/hod', 'Operations overview'],
  ['/admin/twin', 'Campus digital twin'],
  ['/admin/analytics', 'Analytics'],
  ['/admin/accounts', 'Accounts & roles'],
  ['/admin/campus', 'Blocks & spots'],
  ['/admin/categories', 'Issue categories'],
  ['/admin/issues', 'All issues'],
  ['/admin/system', 'System & audit'],
  ['/admin', 'Administration'],
  ['/profile', 'Profile'],
];

function titleFor(pathname: string): string {
  const match = PAGE_TITLES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return match?.[1] ?? 'AI Sustainable Campus';
}

export function AppShell() {
  const user = useCurrentUser();
  const { signOut } = useSession();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Close the mobile drawer whenever the route changes, or the drawer stays open over the
  // page the user just navigated to.
  useEffect(() => {
    setDrawerOpen(false);
    setMenuOpen(false);
  }, [location.pathname]);

  const groups = navGroupsFor(user.role);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <div
        className={`shell__scrim${drawerOpen ? ' shell__scrim--visible' : ''}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      <aside className={`shell__sidebar${drawerOpen ? ' shell__sidebar--open' : ''}`} aria-label="Main navigation">
        <div className="shell__brand">
          <span className="shell__brand-mark" aria-hidden="true">
            ♻
          </span>
          <span className="shell__brand-text">
            <span className="shell__brand-title">AI Sustainable Campus</span>
            <span className="shell__brand-sub">Dayananda Sagar University</span>
          </span>
        </div>

        <nav className="shell__nav">
          {groups.map((group) => (
            <div key={group.heading}>
              <p className="shell__nav-group">{group.heading}</p>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`}
                  onClick={() => setDrawerOpen(false)}
                >
                  <svg className="nav-link__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d={item.icon}
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="shell__sidebar-footer">
          <p>{user.email}</p>
          <p style={{ marginTop: 2, opacity: 0.75 }}>Signed in as {user.role.toLowerCase()}</p>
        </div>
      </aside>

      <div className="shell__main">
        <header className="shell__header">
          <button
            type="button"
            className="btn btn--ghost shell__menu-button"
            onClick={() => setDrawerOpen((open) => !open)}
            aria-expanded={drawerOpen}
            aria-label="Toggle navigation menu"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>

          <div className="shell__header-titles">
            <h1 className="shell__page-title">{titleFor(location.pathname)}</h1>
            <div className="shell__breadcrumbs">
              <NavLink to={homePathFor(user.role)} style={{ textDecoration: 'none' }}>
                {user.role === 'STUDENT' ? 'Student' : user.role === 'HOD' ? 'Department' : 'Administration'}
              </NavLink>
              <WorkspaceTag workspace={user.workspace} />
            </div>
          </div>

          <div className="row" style={{ position: 'relative', gap: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  background: 'var(--green-600)',
                  color: 'white',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {user.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="nowrap">{user.displayName}</span>
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="card"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 'calc(100% + 8px)',
                  width: 232,
                  zIndex: 40,
                  boxShadow: 'var(--shadow-md)',
                  padding: 'var(--space-2)',
                }}
              >
                <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
                  <p className="small strong" style={{ margin: 0 }}>
                    {user.displayName}
                  </p>
                  <p className="small muted" style={{ margin: 0 }}>
                    {user.email}
                  </p>
                </div>
                <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: 'var(--space-2) 0' }} />
                <NavLink to="/profile" className="nav-link" style={{ color: 'var(--text)', background: 'none' }}>
                  Profile
                </NavLink>
                <button
                  type="button"
                  className="btn btn--ghost btn--block"
                  style={{ justifyContent: 'flex-start' }}
                  onClick={handleSignOut}
                  disabled={signingOut}
                >
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            )}
          </div>
        </header>

        <main id="main" className="shell__content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
