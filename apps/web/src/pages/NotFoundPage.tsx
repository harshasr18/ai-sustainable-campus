/**
 * A route that does not exist.
 *
 * Not a dead end: it offers the signed-in user the two things they might have been looking
 * for — their own dashboard, or the profile — and it says plainly that the path is unknown
 * rather than implying the resource exists but is hidden.
 */

import { Link, useLocation } from 'react-router-dom';
import { EmptyPane } from '../components/states.js';
import { homePathFor, useSession } from '../lib/session.js';

export function NotFoundPage() {
  const { user } = useSession();
  const location = useLocation();

  return (
    <EmptyPane
      icon="⌕"
      title="That page does not exist"
      text={`Nothing in this application is routed to ${location.pathname}. If you followed a link to get here, the link is wrong; if you typed it, it may be a page that has not been built yet.`}
      action={
        user ? (
          <Link className="btn btn--primary" to={homePathFor(user.role)}>
            Go to my dashboard
          </Link>
        ) : (
          <Link className="btn btn--primary" to="/login">
            Sign in
          </Link>
        )
      }
    />
  );
}
