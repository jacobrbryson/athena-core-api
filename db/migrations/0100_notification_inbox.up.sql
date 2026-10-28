-- =====================================================================
-- 0100_notification_inbox.up.sql
-- A notification inbox: every push Athena sends is also kept here until the
-- person acknowledges it, so tapping a phone notification (which opens the app
-- and clears the tray entry) can never lose it.
--
-- Written by push.sendToProfile, the one place all pushes pass through. The
-- row is the notification; delivery to phones is a separate concern and a row
-- exists even when push is off or no device is paired. source_uuid is the id the
-- sender gave the push (a nudge's uuid, a trading notification's uuid): the
-- phone's Acknowledge button (POST /dashboard/notifications/:uuid/ack) sends
-- exactly that, and a redelivery of the same one is a no-op.
-- Conventions match 0001-0099: no enforced FK to profile.
-- =====================================================================
CREATE TABLE IF NOT EXISTS athena_notification (
  id BIGINT NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  source_uuid VARCHAR(80) NULL,
  profile_id BIGINT NOT NULL,
  kind VARCHAR(40) NOT NULL DEFAULT 'general',
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  data JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  acknowledged_at DATETIME(3) NULL,
  acknowledged_via VARCHAR(16) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notification_uuid (uuid),
  UNIQUE KEY uq_notification_source (profile_id, source_uuid),
  KEY idx_notification_profile (profile_id, acknowledged_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
