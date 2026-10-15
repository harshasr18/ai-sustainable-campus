-- 0002 — Users and revocable sessions.
--
-- Security notes:
--  * normalized_email is the single uniqueness key for accounts. Normalization
--    (trim + lowercase) happens BEFORE validation in @campus/contracts so that
--    "Student@DSU.edu.in " and "student@dsu.edu.in" resolve to one account.
--  * Sessions store ONLY the SHA-256 hash of the opaque bearer token. If the DB
--    leaks, no session can be replayed. Raw tokens never touch disk.
--  * role is server-assigned. There is no endpoint that accepts a role from a client.

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id),
  normalized_email text NOT NULL,
  display_name     text NOT NULL,
  password_hash    text NOT NULL,
  role             user_role NOT NULL DEFAULT 'STUDENT',
  account_status   account_status NOT NULL DEFAULT 'ACTIVE',
  department       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_users_email UNIQUE (normalized_email),
  CONSTRAINT ck_users_email_shape CHECK (normalized_email = lower(btrim(normalized_email))),
  CONSTRAINT ck_users_email_has_at CHECK (position('@' in normalized_email) > 1),
  CONSTRAINT ck_users_display_name CHECK (length(btrim(display_name)) > 0)
);
CREATE INDEX ix_users_workspace_role ON users (workspace_id, role);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  CONSTRAINT ux_sessions_token UNIQUE (token_hash),
  CONSTRAINT ck_sessions_expiry CHECK (expires_at > issued_at)
);
CREATE INDEX ix_sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;
