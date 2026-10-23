-- Packages left at the door (docs/capabilities/packages.md). A sighting of
-- kind 'package' (services/sightings.js) opens one watch per camera; the
-- bridge sends a fresh frame from that camera later (it schedules the
-- re-check the webhook's answer asks for — Cloud Run jobs can't reach the
-- tailnet bridge), and services/packageWatch.js compares it with the frame
-- the package was first seen in. Household-level like the sightings
-- themselves; who is told is decided by each person's own "package" alert
-- rule. No re-check frame is stored. Pruned with sightings (30 days).
CREATE TABLE IF NOT EXISTS athena_package_watch (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  sighting_uuid CHAR(36) NOT NULL,
  device_serial VARCHAR(40) NOT NULL,
  device_name VARCHAR(120) NULL,
  zone VARCHAR(60) NULL,
  where_text VARCHAR(200) NULL,
  first_seen_at DATETIME(3) NOT NULL,
  frame_uri VARCHAR(512) NULL,
  check_at DATETIME(3) NOT NULL,
  checks_done TINYINT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('waiting','collected','unknown') NOT NULL DEFAULT 'waiting',
  still_there_at DATETIME(3) NULL,
  resolved_at DATETIME(3) NULL,
  collected_by VARCHAR(60) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_package_watch_uuid (uuid),
  KEY idx_package_watch_open (status, device_serial),
  KEY idx_package_watch_seen (first_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
