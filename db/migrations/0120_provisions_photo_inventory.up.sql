-- Family → Provisions photo inventory (2026-11-18): what Athena saw in a photo
-- of the pantry, fridge, freezer or counter (services/provisions/scan.js).
-- The photo itself is never stored; only the item names she read from it.
-- A new scan of a place replaces that place's items.
CREATE TABLE IF NOT EXISTS athena_pantry_item (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid        CHAR(36)        NOT NULL,
  profile_id  BIGINT          NOT NULL,
  place       VARCHAR(16)     NOT NULL,   -- pantry | fridge | freezer | counter
  name        VARCHAR(80)     NOT NULL,
  kind        VARCHAR(16)     NOT NULL,   -- proteins | grains | canned | produce | dairy | frozen | snacks | drinks | other
  amount      VARCHAR(40)     NULL,       -- as seen: "2 cans", "half a carton"
  seen_at     DATETIME        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pantry_item_uuid (uuid),
  KEY idx_pantry_item_place (profile_id, place, seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
