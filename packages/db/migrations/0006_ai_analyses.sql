-- 0006 — AI analysis results (versioned).
--
-- Phase 1 defines the STORAGE and INTERFACE only. The engine is Phase 2 and is
-- deliberately NOT implemented: no fake predictions are ever written here.
-- Rows only appear once a real provider adapter returns a real result.
--
-- Versioning (provider + model + model_version) means swapping a free pretrained
-- model for another never rewrites history or invalidates old analysis.

CREATE TABLE ai_analyses (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces(id),
  report_id              uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  provider               text NOT NULL,
  model                  text NOT NULL,
  model_version          text NOT NULL,
  status                 text NOT NULL,
  predicted_category_id  uuid REFERENCES issue_categories(id) ON DELETE SET NULL,
  category_matches_choice boolean,
  confidence             double precision,
  severity               text,
  repair_recommendation  text,
  /** [{issueId, score, reason}] — candidates only; NEVER auto-merged (brief 18). */
  duplicate_candidates   jsonb NOT NULL DEFAULT '[]'::jsonb,
  requires_human_review  boolean NOT NULL DEFAULT true,
  error_message          text,
  latency_ms             integer,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_ai_status CHECK (status IN ('PENDING','SUCCEEDED','FAILED','NEEDS_HUMAN_REVIEW')),
  CONSTRAINT ck_ai_confidence CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT ck_ai_severity CHECK (severity IS NULL OR severity IN ('LOW','MEDIUM','HIGH','CRITICAL'))
);
CREATE INDEX ix_ai_report ON ai_analyses (report_id, created_at DESC);
