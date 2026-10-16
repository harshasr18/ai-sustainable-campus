-- 0009 — Phase 5: server-issued capture sessions, idempotent submission, evidence hash.
--
-- WHAT THIS DOES AND DOES NOT PROVE (stated here because it is easy to overclaim).
--
-- Before this migration the server accepted ANY image file from ANY authenticated client as a
-- report photo. The only "freshness" information was `captured_at`, a value the client wrote
-- itself. Nothing on the server distinguished a photo taken a second ago from a gallery file.
--
-- A capture session is a random, single-use ticket the web app requests from the server at
-- the moment the shutter is pressed. A report must present a valid, unexpired, unconsumed
-- ticket that belongs to the submitting user. That gives the server three facts it can
-- actually stand behind:
--
--   1. the upload happened within CAPTURE_SESSION_TTL_MINUTES of a server-recorded instant
--      at which this user's client asked for a ticket (`issued_at` is the server clock);
--   2. each ticket produces at most ONE report — a repeated tap, a network retry or a
--      replayed request returns the report that already exists instead of creating another
--      (`reports.capture_session_id` is UNIQUE, so this holds under concurrency);
--   3. byte-identical photographs cannot be submitted twice in a workspace
--      (`evidence_sha256`), which stops naive re-use of one picture for repeated credit.
--
-- It does NOT prove the bytes came from a camera. A modified client can request a ticket
-- and upload any file. Browsers expose no attestation API that would let a server verify
-- camera provenance, so no web application can make that claim honestly; this is the
-- strongest check available without a native app and platform attestation.

CREATE TABLE IF NOT EXISTS capture_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- sha256 of the ticket; the ticket itself is never stored (same rule as session tokens).
  token_hash    text NOT NULL UNIQUE,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  report_id     uuid,
  CONSTRAINT ck_capture_sessions_expiry   CHECK (expires_at > issued_at),
  CONSTRAINT ck_capture_sessions_consumed CHECK ((consumed_at IS NULL) = (report_id IS NULL))
);

CREATE INDEX IF NOT EXISTS ix_capture_sessions_user ON capture_sessions (user_id, issued_at DESC);

ALTER TABLE reports ADD COLUMN IF NOT EXISTS capture_session_id uuid REFERENCES capture_sessions(id);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS capture_metadata   jsonb;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS evidence_sha256    text;

-- One report per ticket, enforced by the database rather than by application code.
CREATE UNIQUE INDEX IF NOT EXISTS ux_reports_capture_session
  ON reports (capture_session_id) WHERE capture_session_id IS NOT NULL;

-- One report per exact photograph per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS ux_reports_evidence_sha256
  ON reports (workspace_id, evidence_sha256) WHERE evidence_sha256 IS NOT NULL;

ALTER TABLE capture_sessions DROP CONSTRAINT IF EXISTS fk_capture_sessions_report;
ALTER TABLE capture_sessions
  ADD CONSTRAINT fk_capture_sessions_report FOREIGN KEY (report_id) REFERENCES reports(id);
