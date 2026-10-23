-- Deliveries read from a person's own Gmail (docs/capabilities/packages.md):
-- shipping and delivery notices — Walmart, Amazon, UPS, USPS, FedEx and the
-- like — get one structured read (services/deliveries.js) after triage, and
-- the latest state per order thread is kept here. Matched against package
-- sightings so "a package is on the porch" can say whose order it is, and so
-- "delivered" with nothing on camera can be noticed. Per person, like the
-- mail it came from; pruned at 60 days.
CREATE TABLE IF NOT EXISTS athena_delivery (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  thread_id VARCHAR(64) NOT NULL,
  gmail_message_id VARCHAR(64) NOT NULL,
  merchant VARCHAR(80) NULL,
  carrier VARCHAR(40) NULL,
  status ENUM('ordered','shipped','out_for_delivery','delivered','delayed') NOT NULL,
  expected_on DATE NULL,
  delivered_at DATETIME(3) NULL,
  items_summary VARCHAR(200) NULL,
  email_at DATETIME(3) NOT NULL,
  sighting_uuid CHAR(36) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery_uuid (uuid),
  UNIQUE KEY uq_delivery_thread (profile_id, thread_id),
  KEY idx_delivery_status (profile_id, status, delivered_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
