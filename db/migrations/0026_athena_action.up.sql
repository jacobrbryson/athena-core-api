-- =====================================================================
-- 0026_athena_action.up.sql
-- Athena's action layer: proposals she makes, and the approvals that let
-- them run.
-- ---------------------------------------------------------------------
-- Every tool Athena had before this was a `get_`. She could tell you your
-- 2pm collides with your flight and could not move the 2pm. These two
-- tables are the actuator, and they are built so that the human stays the
-- one who decides.
--
-- `athena_action` is one row per PROPOSAL, not one row per execution. A
-- proposal is created by the backend from a validated field in her reply
-- (never from free text), shown to the person, and only then executed. The
-- row carries both halves — what was proposed and what happened — so the
-- audit answer to "why did Athena do that?" is a single SELECT.
--
-- Status is the concurrency control, not a label. The pending -> executing
-- transition is a guarded UPDATE with status in the WHERE clause, which is
-- what makes a double-tapped Approve button execute exactly once. There is
-- deliberately no path from a terminal status back to pending: a stale
-- proposal is re-proposed as a new row, never revived.
--
-- `athena_action_authority` is a standing approval: "you may add calendar
-- events without asking each time." It is per profile, per action, with an
-- optional expiry and a hard revoke. It never removes the audit row — a
-- standing approval changes who pressed the button, not whether the press
-- is recorded.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_action (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid           CHAR(36)        NOT NULL,
  profile_id     BIGINT          NOT NULL,
  -- Which conversation this came out of, so the proposal card can be shown
  -- in the right place and the audit can be read next to the transcript.
  session_id     BIGINT          NULL,
  -- Registry action id (e.g. "create_calendar_event"). Not an enum: the
  -- registry is the source of truth and a schema change must not be the
  -- cost of adding an action. An id absent from the registry fails closed
  -- at execute time.
  action_id      VARCHAR(64)     NOT NULL,
  -- Validated, registry-normalized parameters. What the person approved is
  -- THIS json, not the sentence Athena said about it.
  params         JSON            NOT NULL,
  -- Athena's own one-line reason, shown on the card. Model-authored text:
  -- display only, never re-parsed, never trusted as an instruction.
  rationale      VARCHAR(500)    NULL,
  -- Plain-language rendering of `params`, built by the registry's own
  -- summarize() at propose time. Stored rather than re-derived so the audit
  -- shows what the person actually read, even if summarize() changes later.
  summary        VARCHAR(500)    NOT NULL,
  --   pending    proposed, awaiting a human
  --   executing  claimed by exactly one confirm (guarded transition)
  --   done       the provider accepted it
  --   failed     the provider refused, or the executor did
  --   declined   the person said no
  --   expired    nobody answered in time
  status         VARCHAR(16)     NOT NULL DEFAULT 'pending',
  -- How this came to run: "human" (a person pressed Approve) or
  -- "standing" (an athena_action_authority row). Never null once executed,
  -- so no execution can claim ambiguous provenance.
  approval       VARCHAR(16)     NULL,
  -- Set when `approval` = 'standing'. Points at the authority that stood in
  -- for a human, so revoking it makes every execution it authorized findable.
  authority_id   BIGINT UNSIGNED NULL,
  -- Unconfirmed proposals die. A proposal the person never saw must not sit
  -- there approvable a week later, when "add the dentist at 2" means nothing.
  expires_at     DATETIME        NOT NULL,
  -- Provider-side identifier of whatever was created/changed, when there is
  -- one (a Google event id). This is what makes an undo possible later.
  result_ref     VARCHAR(255)    NULL,
  -- Operator-facing failure reason. Provider error text, truncated.
  error          VARCHAR(500)    NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at     DATETIME        NULL,   -- approved or declined
  executed_at    DATETIME        NULL,   -- provider call returned
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_action_uuid (uuid),
  KEY idx_athena_action_profile (profile_id, status),
  KEY idx_athena_action_pending (status, expires_at),
  KEY idx_athena_action_authority (authority_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_action_authority (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id    BIGINT          NOT NULL,
  action_id     VARCHAR(64)     NOT NULL,
  -- Who granted it. The authenticated caller's own profile, never a body
  -- field: a standing approval is exactly the thing worth forging.
  granted_by    BIGINT          NOT NULL,
  -- NULL means "until revoked". A registry action may cap this.
  expires_at    DATETIME        NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at    DATETIME        NULL,
  PRIMARY KEY (id),
  -- One live authority per profile+action. Re-granting updates in place
  -- rather than stacking rows that all have to be revoked separately.
  UNIQUE KEY uq_athena_action_authority (profile_id, action_id),
  KEY idx_athena_action_authority_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
