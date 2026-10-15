-- Food logging by photo, barcode and favorites (Health page, nutrition card).
--
-- nutrition_favorite: foods the person starred, one tap to log again. Keyed
-- by label per person, so starring the same food twice updates it.
-- nutrition_entry gains where an entry came from (typed, a photo estimate, a
-- barcode lookup, a favorite) and, for a barcode, the code and serving size,
-- so the Today list can say "estimated from your photo — check it".

CREATE TABLE IF NOT EXISTS nutrition_favorite (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  label VARCHAR(120) NOT NULL,
  calories SMALLINT UNSIGNED NULL,
  protein_g DECIMAL(5,1) NULL,
  carbs_g DECIMAL(5,1) NULL,
  fat_g DECIMAL(5,1) NULL,
  water_oz DECIMAL(5,1) NULL,
  serving VARCHAR(60) NULL,
  barcode VARCHAR(32) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_nutrition_favorite_uuid (uuid),
  UNIQUE KEY uq_nutrition_favorite_label (profile_id, label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE nutrition_entry
  ADD COLUMN source VARCHAR(16) NULL AFTER water_oz,
  ADD COLUMN serving VARCHAR(60) NULL AFTER source,
  ADD COLUMN barcode VARCHAR(32) NULL AFTER serving;
