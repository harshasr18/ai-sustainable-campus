-- 0005 — Status history, token ledger, audit log, transactional outbox.
--
-- Four integrity pillars:
--  1. issue_status_history  — every transition recorded transactionally (brief 7F).
--  2. token_transactions    — immutable ledger; UNIQUE(idempotency_key) makes
--                             retries physically incapable of double-awarding (brief 7G).
--  3. audit_log             — who did what, with before/after. Never stores secrets.
--  4. event_outbox          — written in the SAME transaction as the state change,
--                             published only after commit (brief 3 Step F / Section 12).

CREATE TABLE issue_status_history (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id),
  issue_id           uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  previous_status    text,
  new_status         text NOT NULL,
  changed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_history_new_status CHECK (new_status IN ('SUBMITTED','APPROVED','IN_PROGRESS','RESOLVED')),
  CONSTRAINT ck_history_prev_status CHECK (previous_status IS NULL OR previous_status IN ('SUBMITTED','APPROVED','IN_PROGRESS','RESOLVED'))
);
CREATE INDEX ix_history_issue ON issue_status_history (issue_id, created_at);

CREATE TABLE token_transactions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  report_id          uuid REFERENCES reports(id) ON DELETE SET NULL,
  transaction_type   text NOT NULL,
  amount             integer NOT NULL,
  idempotency_key    text NOT NULL,
  reason             text,
  /** NULL for automatic system credits; set for staff-initiated reversals. */
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_txn_type   CHECK (transaction_type IN ('CREDIT','REVERSAL')),
  -- Integer amounts, strictly positive (brief: "Store token amounts as integers").
  CONSTRAINT ck_txn_amount CHECK (amount > 0),
  -- A staff reversal must name its reason and its actor (brief Step C).
  CONSTRAINT ck_txn_reversal_attribution CHECK (
    transaction_type <> 'REVERSAL'
    OR (reason IS NOT NULL AND length(btrim(reason)) > 0 AND created_by_user_id IS NOT NULL)
  ),
  -- THE retry guard. A duplicate award is impossible at the storage layer.
  CONSTRAINT ux_token_idempotency UNIQUE (idempotency_key)
);
CREATE INDEX ix_txn_user ON token_transactions (user_id, created_at DESC);
CREATE INDEX ix_txn_report ON token_transactions (report_id) WHERE report_id IS NOT NULL;

CREATE TABLE audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     uuid,
  before_state  jsonb,
  after_state   jsonb,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX ix_audit_actor  ON audit_log (actor_user_id, created_at DESC);

CREATE TABLE event_outbox (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id),
  event_type     text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      uuid NOT NULL,
  /** Monotonic per-entity version so consumers can order and detect gaps. */
  entity_version integer NOT NULL,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  payload        jsonb NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,

  CONSTRAINT ck_outbox_event_type CHECK (event_type IN (
    'report.created','report.validated','issue.created','issue.duplicate_linked',
    'issue.status_changed','issue.claimed','issue.resolved','token.credited','token.reversed'
  )),
  CONSTRAINT ck_outbox_entity_type CHECK (entity_type IN ('REPORT','ISSUE','TOKEN_TRANSACTION'))
);
-- Undelivered events, in order. The future WebSocket/SSE transport polls this.
CREATE INDEX ix_outbox_unpublished ON event_outbox (occurred_at) WHERE published_at IS NULL;
