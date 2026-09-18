-- =====================================================================
-- 0029_trigger_score.up.sql
-- Athena learning which of her interruptions were actually wanted.
-- ---------------------------------------------------------------------
-- 0027 recorded how each nudge landed and left a human to read it in the
-- nightly review. That is a report, not a correction: a trigger nobody
-- wants keeps firing until somebody notices the report and edits code.
--
-- This table is the correction. One learned score per person per
-- trigger, moved by what actually happened after each nudge -- ignored,
-- answered warmly, waved away, or told to stop.
--
-- THE HARD RULE, and the reason this is safe to let her adjust herself:
-- the score may only ever make her QUIETER. It decides which triggers
-- compete for the person's fixed interruption budget, and can suppress
-- one outright. It cannot raise the daily cap, shorten the spacing,
-- pierce quiet hours, or un-mute anything. Those are the person's
-- settings and only the person moves them (see the root AGENTS.md).
-- Learning that redistributes a fixed budget is a different thing from
-- learning that enlarges it, and only the first is hers to do.
--
-- `score` is an exponentially weighted moving average in [0,1] starting
-- at 0.5, so the most recent reactions dominate and an old opinion
-- decays instead of anchoring her forever.
--
-- `suppressed_at` is Athena muting herself. Deliberately distinct from
-- `athena_trigger_mute`, which is the person's decision: hers is
-- reversible by a few good outcomes, theirs is not reversible by her at
-- all. Collapsing the two would let her talk herself back into something
-- a person switched off.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_trigger_score (
  profile_id   BIGINT       NOT NULL,
  trigger_id   VARCHAR(64)  NOT NULL,
  -- 0.000-1.000. 0.5 is "no opinion yet".
  score        DECIMAL(4,3) NOT NULL DEFAULT 0.500,
  -- How many judged outcomes have moved it. A score with two samples
  -- behind it must not be trusted like one with thirty.
  samples      INT UNSIGNED NOT NULL DEFAULT 0,
  -- The last thing that moved it, in plain language, so the settings
  -- panel can say WHY she went quiet instead of showing a number.
  last_reason  VARCHAR(300) NULL,
  -- Set when Athena has decided to stop raising this herself. Cleared if
  -- the person explicitly asks for it back.
  suppressed_at DATETIME    NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, trigger_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The appraisal of one nudge, kept on the nudge itself.
--
-- `appraisal` holds the model's structured judgement: what the reply
-- signalled, and whether the interruption looks worth having made. It is
-- evidence, not authority -- the deterministic reaction (engaged /
-- dismissed / expired) is still recorded separately and a judgement can
-- never contradict what the person actually did.
ALTER TABLE athena_nudge
  ADD COLUMN appraisal   JSON     NULL AFTER facts,
  ADD COLUMN appraised_at DATETIME NULL AFTER appraisal;
