-- 0008 — Phase 3: two new issue events.
--
-- WHY A MIGRATION RATHER THAN REUSING AN EXISTING VERB.
-- Migration 0005 constrained `event_outbox.event_type` to the Phase 1 verbs, and 0007
-- extended that list for the AI pipeline. Phase 3 adds two operations that are genuinely
-- not status transitions:
--
--   * an HOD confirming the OPERATIONAL severity of an issue (which lives in a different
--     column from the model's `reports.ai_severity` and must never be conflated with it);
--   * an HOD correcting a mis-filed category.
--
-- Publishing either as `issue.status_changed` would be a lie in the event log: a consumer
-- rebuilding state from events would see a status change that never happened. The CHECK
-- constraint is doing its job by refusing the new names until they are declared here.
--
-- This is additive and idempotent: the list is restated in full so re-running the migration
-- on an already-migrated database produces the same constraint.

ALTER TABLE event_outbox DROP CONSTRAINT IF EXISTS ck_outbox_event_type;

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
  -- Phase 2 — AI analysis lifecycle
  'report.analysis_started',
  'report.analysis_completed',
  'report.analysis_failed',
  'report.review_required',
  -- Phase 2 — duplicate handling
  'report.duplicate_candidate_found',
  'report.linked_to_master_issue',
  'report.duplicate_rejected',
  -- Phase 3 — human corrections to the operational record
  'issue.severity_changed',
  'issue.category_changed'
));
