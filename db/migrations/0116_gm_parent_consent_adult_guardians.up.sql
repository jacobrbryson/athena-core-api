-- Owner 2026-11-01: a parent's agreement is enough for a minor, who can still
-- stop at any time; and a Guardian can be an adult, who agrees for themselves.
-- The words a parent agreed to promised the child would be asked too, so they
-- get a new version rather than an edit, and parents agree to it once more.

SET @has_adult := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'athena_gm_actor' AND COLUMN_NAME = 'is_adult');
SET @add_adult := IF(@has_adult = 0, 'ALTER TABLE athena_gm_actor ADD COLUMN is_adult TINYINT(1) NOT NULL DEFAULT 0 AFTER kind', 'DO 0');
PREPARE add_adult FROM @add_adult;
EXECUTE add_adult;
DEALLOCATE PREPARE add_adult;

UPDATE athena_gm_actor SET is_adult = 1 WHERE family_id = 2 AND actor_key IN ('lena', 'livia');

INSERT INTO athena_gm_consent_terms (version, audience, title, body, body_sha256)
SELECT 2, t.audience, t.title, t.new_body, SHA2(t.new_body, 256)
FROM (
  SELECT audience, title,
    REPLACE(REPLACE(body,
      'By agreeing, you allow your child to take part, and your child will be asked to agree too. Both of you must agree.',
      'By agreeing, you allow your child to take part. As their parent, your agreement is what lets them join.'),
      'until you and your child agree again',
      'until you agree again') AS new_body
  FROM athena_gm_consent_terms WHERE audience = 'parent_for_child' AND version = 1
) t
WHERE NOT EXISTS (SELECT 1 FROM athena_gm_consent_terms WHERE audience = 'parent_for_child' AND version = 2);
