-- =====================================================================
-- 0027_athena_initiative.up.sql
-- Athena speaking first.
-- ---------------------------------------------------------------------
-- Until now every word Athena said was a reply. This is the part where
-- she starts the conversation -- and the entire schema exists to make
-- that rare, accountable, and easy to switch off.
--
-- The division of labour matters and is encoded here: RULES decide
-- whether to interrupt, the MODEL only decides how to word it. So
-- `facts` holds what the trigger actually observed (deterministic, the
-- audit answer to "why did she say that?") and `text` holds the wording
-- (model-authored, display only, never re-parsed).
--
-- `dedupe_key` is the load-bearing column. It names the specific
-- occurrence a trigger fired on -- a calendar event id, a date -- and
-- the unique key over (profile, trigger, dedupe_key) is what stops the
-- same 2pm meeting being announced every time the evaluator runs. That
-- also makes the evaluator safe to run from several places at once: a
-- duplicate is a failed INSERT, not a second interruption.
--
-- `athena_nudge_reaction` is not decoration. A system that interrupts
-- people and never learns whether the interruption was welcome will
-- degrade into noise, so the reaction is recorded per nudge and rolled
-- up by the nightly review into a per-trigger acceptance rate.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_nudge (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid        CHAR(36)        NOT NULL,
  profile_id  BIGINT          NOT NULL,
  -- Registry trigger id (e.g. "calendar_next_up"). Not an enum, for the
  -- same reason athena_action.action_id isn't: the registry is the source
  -- of truth and adding a trigger must not need a schema change.
  trigger_id  VARCHAR(64)     NOT NULL,
  -- The specific occurrence. Capped at 190 so the unique key below fits
  -- in InnoDB's 3072-byte index limit under utf8mb4.
  dedupe_key  VARCHAR(190)    NOT NULL,
  urgency     VARCHAR(16)     NOT NULL DEFAULT 'normal',  -- low | normal | high
  -- What she says. Model-authored: shown to a person, never parsed back,
  -- never treated as an instruction.
  text        VARCHAR(500)    NOT NULL,
  -- What the trigger observed, deterministically. This is the honest
  -- answer to "why did she bring that up?" and it does not depend on the
  -- model having described itself accurately.
  facts       JSON            NULL,
  --   pending    written, not yet shown to anyone
  --   delivered  the person's client has fetched it
  --   engaged    they replied to it / acted on it
  --   dismissed  they waved it away
  --   expired    it stopped being true before they saw it
  status      VARCHAR(16)     NOT NULL DEFAULT 'pending',
  -- When the observation stops being worth saying. A "starts in 10
  -- minutes" nudge is worse than useless an hour later.
  expires_at  DATETIME        NOT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at DATETIME       NULL,
  reacted_at  DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_nudge_uuid (uuid),
  -- The interruption budget's hard floor: one nudge per occurrence, ever.
  UNIQUE KEY uq_athena_nudge_occurrence (profile_id, trigger_id, dedupe_key),
  KEY idx_athena_nudge_pending (profile_id, status, expires_at),
  KEY idx_athena_nudge_created (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-person interruption settings. A row here IS the opt-in: no row
-- means Athena never speaks first, which is the default for everyone.
CREATE TABLE IF NOT EXISTS athena_initiative_pref (
  profile_id  BIGINT          NOT NULL,
  enabled     TINYINT(1)      NOT NULL DEFAULT 0,
  -- Their own timezone, sent by the app. Quiet hours are meaningless
  -- without it, and a background job has no device to ask.
  timezone    VARCHAR(64)     NULL,
  -- Local hours between which she stays silent. from > to wraps midnight,
  -- which is the normal case (22 -> 7).
  quiet_from  TINYINT UNSIGNED NOT NULL DEFAULT 22,
  quiet_to    TINYINT UNSIGNED NOT NULL DEFAULT 7,
  -- Hard ceiling per local day. Deliberately small.
  daily_cap   TINYINT UNSIGNED NOT NULL DEFAULT 3,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- "Never bring this up again." Per trigger, per person, revocable.
-- A separate table rather than a JSON column so the evaluator can filter
-- in SQL instead of loading every preference row to decide.
CREATE TABLE IF NOT EXISTS athena_trigger_mute (
  profile_id  BIGINT          NOT NULL,
  trigger_id  VARCHAR(64)     NOT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, trigger_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
