-- 0007 — AI pipeline event types (Phase 2).
--
-- WHY A MIGRATION IS NEEDED AT ALL:
-- migration 0005 constrained event_outbox.event_type to the nine Phase 1 verbs, which
-- is exactly what a CHECK constraint should do — it prevented the Phase 2 pipeline from
-- silently inventing event names. The first run of tests/ai-provider.test.ts failed with
--   new row for relation "event_outbox" violates check constraint "ck_outbox_event_type"
-- which is the constraint working as designed. This migration widens the allowed set to
-- include the events the brief lists in §17.
--
-- NON-DESTRUCTIVE: DROP CONSTRAINT + ADD CONSTRAINT rewrites no rows and no table. Every
-- previously-valid event type is still valid, so existing outbox history and any
-- unconsumed events remain readable and intact.

ALTER TABLE event_outbox DROP CONSTRAINT ck_outbox_event_type;

ALTER TABLE event_outbox ADD CONSTRAINT ck_outbox_event_type CHECK (event_type IN (
  -- Phase 1
  'report.created',
  'report.validated',
  'issue.created',
  'issue.duplicate_linked',
  'issue.status_changed',
  'issue.claimed',
  'issue.resolved',
  'token.credited',
  'token.reversed',
  -- Phase 2 — AI analysis lifecycle (brief §17)
  'report.analysis_started',
  'report.analysis_completed',
  'report.analysis_failed',
  'report.review_required',
  -- Phase 2 — duplicate handling
  'report.duplicate_candidate_found',
  'report.linked_to_master_issue',
  'report.duplicate_rejected'
));
