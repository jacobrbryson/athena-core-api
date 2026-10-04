ALTER TABLE athena_neighbor ADD COLUMN contact_id VARCHAR(20) NULL AFTER contact;
UPDATE athena_neighbor n
  JOIN (SELECT neighbor_id, MIN(contact_id) AS contact_id FROM athena_neighbor_contact GROUP BY neighbor_id) c
  ON c.neighbor_id = n.id
  SET n.contact_id = c.contact_id;
DROP TABLE IF EXISTS athena_neighbor_contact;
ALTER TABLE athena_neighbor
  DROP INDEX uq_athena_neighbor_address,
  DROP COLUMN longitude, DROP COLUMN latitude, DROP COLUMN address_key, DROP COLUMN address;
