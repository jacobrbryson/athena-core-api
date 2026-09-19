-- =====================================================================
-- 0033_look_request.up.sql
-- Athena asking to look, when the camera is not where she is.
-- ---------------------------------------------------------------------
-- The action layer executes server-side: `execute(profileId, params)`
-- calls a provider and returns a result. A camera breaks that shape --
-- it is in a browser on someone's desk, and the server cannot reach it.
--
-- So `look_through_camera` executes by RECORDING a request here, and the
-- device fulfils it. The action succeeded at asking; whether a frame came
-- back is this row's business, which is why `status` is separate from the
-- action's own.
--
-- WHY THIS IS NOT A BACKDOOR. A row here does nothing on its own. It is
-- only ever written through the action layer, which means gates 1-4 have
-- already run: the id was in the registry, the params were vouched for,
-- live access was re-checked, and either the person pressed Approve or a
-- standing approval they granted stood in for it. Revoking that approval
-- (athena_action_authority) stops new rows being written at all, and the
-- device ignores anything expired.
--
-- The device side treats this as a REQUEST, never an instruction: it
-- fulfils one only while the app is open and the person's grant is live,
-- and it puts the camera indicator up for the duration. A look nobody
-- could see happening is the thing that would make this indefensible.
--
-- TTL is short by design. A request that has been sitting for minutes is
-- no longer about the moment she asked, and answering it late would show
-- her a scene she has no context for.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_look_request (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid        CHAR(36)     NOT NULL,
  profile_id  BIGINT       NOT NULL,
  -- The athena_action this came from, so a look is always traceable back
  -- to the proposal and the approval that authorized it.
  action_uuid CHAR(36)     NULL,
  -- Why she wants to look, in her own words. Shown to the person -- a
  -- camera opening with no stated reason is not something to ship.
  reason      VARCHAR(300) NULL,
  -- 'front' | 'room'. A hint, not a command: the device decides what it
  -- actually has, and a phone with one camera simply uses it.
  prefer      VARCHAR(20)  NULL,
  -- pending -> fulfilled | declined | expired
  status      VARCHAR(20)  NOT NULL DEFAULT 'pending',
  -- Set when a device actually captured for this request.
  fulfilled_at DATETIME    NULL,
  expires_at  DATETIME     NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_look_request_uuid (uuid),
  KEY idx_look_request_pending (profile_id, status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
