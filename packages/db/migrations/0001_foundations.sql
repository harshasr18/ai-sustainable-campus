-- 0001 — Foundations: enum types, workspaces, configurable settings.
--
-- Workspace isolation (brief Section 7J): EVERY scoped table carries workspace_id.
-- Isolation is enforced in the query layer (packages/db/src/repositories.ts) and is
-- derived from the authenticated session — never from a client-supplied value.

CREATE TYPE workspace_kind AS ENUM ('REAL', 'DEMO');
CREATE TYPE user_role      AS ENUM ('STUDENT', 'HOD', 'ADMIN');
CREATE TYPE account_status AS ENUM ('ACTIVE', 'SUSPENDED');

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        workspace_kind NOT NULL,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_workspaces_kind UNIQUE (kind)
);

CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Brief Step D: the 72-hour overdue threshold must stay configurable, not hardcoded.
INSERT INTO app_settings (key, value) VALUES
  ('overdue_hours', '72'::jsonb),
  ('tokens_per_validated_report', '10'::jsonb);

INSERT INTO workspaces (kind, name, description) VALUES
  ('REAL', 'Dayananda Sagar University — Main Campus', 'Authoritative production records'),
  ('DEMO', 'Demo Sandbox', 'Judge/demo workspace. Logically isolated from real records.');
