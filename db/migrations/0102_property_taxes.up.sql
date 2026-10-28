-- =====================================================================
-- 0102_property_taxes.up.sql
-- Property tax records, and the log of bills Athena has read.
--
-- A tax bill (real estate, or the vehicle tax a state bills with the tag) is a
-- record with a jurisdiction, a parcel or account, a tax year and one or more
-- installments, each with its own due date and paid date. Shown under
-- Property -> Taxes and on the Home deadline banner.
--
-- athena_bill_scan is the log of every bill photo read ("Scan a bill"): the
-- fields Athena extracted and what became of them. The IMAGE is never stored
-- (the same rule as food scans) - only the extracted fields, which can carry a
-- plate, a parcel or an account number, so it is profile-scoped and holds
-- nothing else. `fingerprint` is what makes scanning the same bill twice
-- harmless: one applied row per bill, per person.
-- =====================================================================
CREATE TABLE IF NOT EXISTS athena_property_tax (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  property_uuid CHAR(36) NULL,
  kind ENUM('property','vehicle') NOT NULL DEFAULT 'property',
  vehicle_uuid CHAR(36) NULL,
  jurisdiction VARCHAR(160) NOT NULL,
  parcel VARCHAR(80) NULL,
  account VARCHAR(80) NULL,
  tax_year SMALLINT NULL,
  amount DECIMAL(12,2) NULL,
  address VARCHAR(240) NULL,
  record_key VARCHAR(190) NOT NULL,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_property_tax_uuid (uuid),
  UNIQUE KEY uq_property_tax_key (profile_id, record_key),
  KEY idx_property_tax_profile (profile_id, property_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_property_tax_installment (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  tax_id BIGINT UNSIGNED NOT NULL,
  label VARCHAR(60) NOT NULL DEFAULT 'Due',
  due_on DATE NOT NULL,
  amount DECIMAL(12,2) NULL,
  paid_on DATE NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_property_tax_installment_uuid (uuid),
  UNIQUE KEY uq_property_tax_installment_due (tax_id, due_on),
  CONSTRAINT fk_property_tax_installment FOREIGN KEY (tax_id) REFERENCES athena_property_tax (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_bill_scan (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  fingerprint CHAR(64) NULL,
  doc_kind VARCHAR(30) NOT NULL,
  fields JSON NULL,
  status ENUM('read','proposed','applied') NOT NULL DEFAULT 'read',
  action_uuid CHAR(36) NULL,
  calendar_refs JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bill_scan_uuid (uuid),
  UNIQUE KEY uq_bill_scan_fingerprint (profile_id, fingerprint),
  KEY idx_bill_scan_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
