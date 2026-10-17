DROP TABLE IF EXISTS athena_site_check;
DELETE FROM athena_workplace_link WHERE kind IN ('site', 'project');
ALTER TABLE athena_workplace_link
  DROP INDEX uq_athena_workplace_link_project,
  DROP INDEX uq_athena_workplace_link_site,
  DROP COLUMN project_uuid,
  DROP COLUMN site_uuid;
