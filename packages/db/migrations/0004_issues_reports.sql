-- 0004 — Master issues and student reports.
--
-- THE DUPLICATE GUARD (brief Section 8 + verified in Stage 1, Section 3.6):
--   CREATE UNIQUE INDEX ux_issues_dedupe_active ... WHERE status <> 'RESOLVED'
-- A partial unique index is the ONLY reliable defence. Stage 1 proved that with an
-- application-level "check then insert", 10 genuinely concurrent transactions all
-- observed an empty table and created 10 master tickets for one defect. With this
-- index plus `ON CONFLICT (dedupe_key) WHERE status <> 'RESOLVED' DO NOTHING`,
-- the same load produced exactly 1 ticket and linked the other 9.
--
-- IMPORTANT: because the index is PARTIAL, any ON CONFLICT clause must repeat the
-- predicate, otherwise PostgreSQL cannot infer the arbiter index.
--
-- The predicate also means a NEW ticket may be raised if the same defect recurs
-- after resolution — correct behaviour for a maintenance system.

CREATE TABLE issues (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id),
  public_reference   text NOT NULL,
  title              text NOT NULL,
  description        text,
  category_id        uuid NOT NULL REFERENCES issue_categories(id) ON DELETE RESTRICT,
  severity           text,
  status             text NOT NULL DEFAULT 'SUBMITTED',
  block_id           uuid NOT NULL REFERENCES campus_blocks(id) ON DELETE RESTRICT,
  spot_id            uuid NOT NULL REFERENCES campus_spots(id) ON DELETE RESTRICT,
  claimed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  resolution_note    text,
  due_at             timestamptz NOT NULL,
  approved_at        timestamptz,
  started_at         timestamptz,
  resolved_at        timestamptz,
  /** Identity of the real-world defect; drives the partial unique index below. */
  dedupe_key         text NOT NULL,
  /** Optimistic concurrency: guards the double-claim race (brief Section 8). */
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ux_issues_public_reference UNIQUE (public_reference),
  CONSTRAINT ck_issues_status CHECK (status IN ('SUBMITTED','APPROVED','IN_PROGRESS','RESOLVED')),
  CONSTRAINT ck_issues_severity CHECK (severity IS NULL OR severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),

  -- Brief: "Resolution requires a non-empty completion note." Enforced at the
  -- storage layer too, so no code path — however buggy — can persist a bare RESOLVED.
  CONSTRAINT ck_issues_resolution_note CHECK (
    status <> 'RESOLVED'
    OR (resolution_note IS NOT NULL AND length(btrim(resolution_note)) > 0)
  ),
  -- Lifecycle timestamps must be consistent with the status they describe.
  CONSTRAINT ck_issues_approved_at CHECK (status = 'SUBMITTED' OR approved_at IS NOT NULL),
  CONSTRAINT ck_issues_started_at  CHECK (status NOT IN ('IN_PROGRESS','RESOLVED') OR started_at  IS NOT NULL),
  CONSTRAINT ck_issues_resolved_at CHECK (status <> 'RESOLVED' OR resolved_at IS NOT NULL),
  CONSTRAINT ck_issues_version_positive CHECK (version > 0)
);

-- The duplicate guard. Scoped by workspace so DEMO and REAL can never collide.
CREATE UNIQUE INDEX ux_issues_dedupe_active
  ON issues (workspace_id, dedupe_key)
  WHERE status <> 'RESOLVED';

CREATE INDEX ix_issues_workspace_status  ON issues (workspace_id, status, created_at DESC);
CREATE INDEX ix_issues_workspace_block   ON issues (workspace_id, block_id, status);
CREATE INDEX ix_issues_claimed_by        ON issues (workspace_id, claimed_by_user_id) WHERE claimed_by_user_id IS NOT NULL;
-- Supports the "overdue" report without hardcoding the threshold anywhere.
CREATE INDEX ix_issues_due_at_open       ON issues (workspace_id, due_at) WHERE status <> 'RESOLVED';

CREATE TABLE reports (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id),
  /** NULL until triage links this report to a master repair ticket. */
  issue_id                 uuid REFERENCES issues(id) ON DELETE SET NULL,
  reporter_user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  selected_category_id     uuid NOT NULL REFERENCES issue_categories(id) ON DELETE RESTRICT,
  ai_predicted_category_id uuid REFERENCES issue_categories(id) ON DELETE SET NULL,
  ai_confidence            double precision,
  ai_severity              text,
  repair_recommendation    text,
  validation_status        text NOT NULL DEFAULT 'PENDING',
  duplicate_match_status   text NOT NULL DEFAULT 'NOT_CHECKED',
  block_id                 uuid NOT NULL REFERENCES campus_blocks(id) ON DELETE RESTRICT,
  spot_id                  uuid NOT NULL REFERENCES campus_spots(id) ON DELETE RESTRICT,
  latitude                 double precision,
  longitude                double precision,
  /** CLIENT-CLAIMED capture time. Evidence only — never proof of authenticity. */
  captured_at              timestamptz,
  /** SERVER-RECORDED. The authoritative submission time. */
  submitted_at             timestamptz NOT NULL DEFAULT now(),
  evidence_storage_key     text,
  reporting_context        jsonb,

  CONSTRAINT ck_reports_validation_status CHECK (validation_status IN
    ('PENDING','AI_VALIDATED','HUMAN_VALIDATED','DUPLICATE_VALIDATED','REJECTED')),
  CONSTRAINT ck_reports_duplicate_status CHECK (duplicate_match_status IN
    ('NOT_CHECKED','NO_MATCH','CANDIDATE_FOUND','LINKED','HUMAN_OVERRIDDEN')),
  CONSTRAINT ck_reports_ai_confidence CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)),
  CONSTRAINT ck_reports_lat CHECK (latitude  IS NULL OR (latitude  >= -90  AND latitude  <= 90)),
  CONSTRAINT ck_reports_lng CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))
);

CREATE INDEX ix_reports_reporter   ON reports (workspace_id, reporter_user_id, submitted_at DESC);
CREATE INDEX ix_reports_issue      ON reports (workspace_id, issue_id) WHERE issue_id IS NOT NULL;
-- Cannot link a report as a confirmed duplicate without naming the master issue.
-- (NOT VALID-free, enforced going forward for every insert/update.)
CREATE INDEX ix_reports_pending    ON reports (workspace_id, submitted_at) WHERE validation_status = 'PENDING';
