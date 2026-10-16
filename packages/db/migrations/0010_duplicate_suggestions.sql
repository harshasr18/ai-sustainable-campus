-- 0010 — Phase 5: uncertain duplicate matches go to a human; confirmed ones are merged.
--
-- BEFORE: `CANDIDATE_FOUND` existed in the report enum but nothing ever produced it, and an
-- HOD had no way to say "these two tickets are the same defect". Only the deterministic
-- rule (same spot + same category, enforced by ux_issues_dedupe_active) linked reports.
--
-- THIS MIGRATION ADDS TWO THINGS.
--
-- 1. `duplicate_suggestions` — a POSSIBLE match the server found after analysing a report
--    that opened its own issue. Produced by an explicit, multi-signal rule (see
--    apps/api/src/duplicates.ts), never by visual similarity alone and never across blocks.
--    It carries the signals that fired, NOT a similarity score: there is no calibrated score
--    to give, and inventing one would be dishonest. A suggestion changes nothing by itself.
--
-- 2. Issue status 'DUPLICATE' ("merged") — set ONLY when an HOD/ADMIN confirms a suggestion.
--    The duplicate ticket's reports are moved onto the master, the ticket keeps its history
--    and points at the master through `duplicate_of_issue_id`, and it stops counting as an
--    open repair task. Nothing is deleted. It is terminal, like RESOLVED.

CREATE TABLE IF NOT EXISTS duplicate_suggestions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id),
  report_id           uuid NOT NULL REFERENCES reports(id),
  source_issue_id     uuid NOT NULL REFERENCES issues(id),
  candidate_issue_id  uuid NOT NULL REFERENCES issues(id),
  reason_code         text NOT NULL,
  -- The facts that fired, e.g. {"sameBlock":true,"sameSpot":true,"aiCategoryMatches":true}.
  signals             jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'OPEN',
  created_at          timestamptz NOT NULL DEFAULT now(),
  decided_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at          timestamptz,
  decision_note       text,
  CONSTRAINT ck_dup_suggestion_status CHECK (status IN ('OPEN','CONFIRMED','DISMISSED','SUPERSEDED')),
  CONSTRAINT ck_dup_suggestion_reason CHECK (reason_code IN ('SAME_SPOT_AI_CATEGORY','SAME_BLOCK_SAME_CATEGORY_RECENT')),
  CONSTRAINT ck_dup_suggestion_distinct CHECK (source_issue_id <> candidate_issue_id),
  CONSTRAINT ck_dup_suggestion_decided CHECK ((status = 'OPEN') = (decided_at IS NULL))
);

-- At most one suggestion per (report, candidate) — re-analysis cannot pile up copies.
CREATE UNIQUE INDEX IF NOT EXISTS ux_dup_suggestion_pair ON duplicate_suggestions (report_id, candidate_issue_id);
CREATE INDEX IF NOT EXISTS ix_dup_suggestion_open ON duplicate_suggestions (workspace_id, status, created_at DESC);

-- Issue status gains the terminal 'DUPLICATE'.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS duplicate_of_issue_id uuid REFERENCES issues(id);

ALTER TABLE issues DROP CONSTRAINT IF EXISTS ck_issues_status;
ALTER TABLE issues ADD CONSTRAINT ck_issues_status
  CHECK (status IN ('SUBMITTED','APPROVED','IN_PROGRESS','RESOLVED','DUPLICATE'));

ALTER TABLE issues DROP CONSTRAINT IF EXISTS ck_issues_approved_at;
ALTER TABLE issues ADD CONSTRAINT ck_issues_approved_at
  CHECK (status IN ('SUBMITTED','DUPLICATE') OR approved_at IS NOT NULL);

ALTER TABLE issues DROP CONSTRAINT IF EXISTS ck_issues_duplicate_of;
ALTER TABLE issues ADD CONSTRAINT ck_issues_duplicate_of
  CHECK ((status = 'DUPLICATE') = (duplicate_of_issue_id IS NOT NULL) AND duplicate_of_issue_id IS DISTINCT FROM id);

-- A merged ticket no longer holds its dedupe key: a NEW report at that spot+category must
-- find the master (or open a fresh ticket), never the merged shell.
DROP INDEX IF EXISTS ux_issues_dedupe_active;
CREATE UNIQUE INDEX ux_issues_dedupe_active
  ON issues (workspace_id, dedupe_key)
  WHERE status NOT IN ('RESOLVED','DUPLICATE');

DROP INDEX IF EXISTS ix_issues_due_at_open;
CREATE INDEX ix_issues_due_at_open ON issues (workspace_id, due_at) WHERE status NOT IN ('RESOLVED','DUPLICATE');

-- The status history must be able to record the merge as a transition.
ALTER TABLE issue_status_history DROP CONSTRAINT IF EXISTS ck_history_new_status;
ALTER TABLE issue_status_history ADD CONSTRAINT ck_history_new_status
  CHECK (new_status IN ('SUBMITTED','APPROVED','IN_PROGRESS','RESOLVED','DUPLICATE'));
