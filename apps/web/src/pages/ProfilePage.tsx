/**
 * Profile — the signed-in user's own account (§4).
 *
 * READ-ONLY, AND THAT IS THE POINT. §4 requires that a user cannot elevate their own
 * privileges, and the backend enforces it (an ADMIN cannot change their own role either). So
 * this page shows the identity the session is actually carrying and offers nothing that
 * looks like an editing control. A disabled "change my role" dropdown would be worse than no
 * dropdown: it would suggest the option exists somewhere.
 *
 * Changing your own password is genuinely useful and genuinely absent from the API, so it is
 * listed as a gap rather than faked with a form that posts nowhere.
 */

import { useNavigate } from 'react-router-dom';
import { Card, Detail, DetailList } from '../components/data.js';
import { WorkspaceTag } from '../components/badges.js';
import { InlineAlert } from '../components/states.js';
import { homePathFor, roleLabel, useSession } from '../lib/session.js';

export function ProfilePage() {
  const { user, signOut } = useSession();
  const navigate = useNavigate();

  if (!user) return null;

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">Your account</h2>
          <p className="page-head__subtitle">
            This is the identity your session is carrying. It was issued by the server and the
            browser cannot change it.
          </p>
        </div>
      </div>

      <div className="grid-2">
        <Card title="Identity">
          <DetailList>
            <Detail label="Name">{user.displayName}</Detail>
            <Detail label="Email">
              <span className="mono">{user.email}</span>
            </Detail>
            <Detail label="Role">
              <strong>{roleLabel(user.role)}</strong>
              <span className="small muted" style={{ display: 'block' }}>
                Decides which pages and API routes this account can reach.
              </span>
            </Detail>
            <Detail label="Account status">{user.accountStatus}</Detail>
            <Detail label="Workspace">
              <WorkspaceTag workspace={user.workspace} />
              <span className="small muted" style={{ display: 'block', marginTop: 4 }}>
                {user.workspace === 'DEMO'
                  ? 'You are working in the demonstration workspace. Records here are never mixed with the real campus.'
                  : 'You are working in the live campus workspace.'}
              </span>
            </Detail>
            <Detail label="User id">
              <span className="mono small">{user.id}</span>
            </Detail>
          </DetailList>
        </Card>

        <Card title="What you can and cannot do">
          <ul className="plain-list">
            <li>
              <strong>Reaching a page is not permission.</strong> Every request this app makes is
              authorised by the server against your session. Navigating to another role's URL will
              show a refusal, and the underlying API calls would fail even if the page rendered.
            </li>
            <li>
              <strong>You cannot change your own role.</strong> Role changes go through an admin-only
              endpoint that refuses self-changes, so no combination of buttons here can raise your
              privileges.
            </li>
            <li>
              <strong>Your reports and photographs are private.</strong> A student can read only their
              own evidence; staff can read evidence within their own workspace. Photos are never
              served from a public URL.
            </li>
          </ul>

          <div className="mt-4">
            <InlineAlert variant="info" title="Not implemented yet">
              Changing your own password or display name has no endpoint on this API — there is no
              <span className="mono"> PATCH /v1/auth/me</span>. It is listed as a gap rather than
              offered as a form that would post nowhere.
            </InlineAlert>
          </div>

          <div className="btn-row mt-5">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                void signOut().then(() => navigate('/login', { replace: true }));
              }}
            >
              Sign out
            </button>
            <a className="btn btn--ghost" href={homePathFor(user.role)}>
              Back to my dashboard
            </a>
          </div>
        </Card>
      </div>
    </>
  );
}
