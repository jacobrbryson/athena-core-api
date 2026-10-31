ALTER TABLE athena_gm_actor DROP COLUMN can_create_templates;
ALTER TABLE athena_gm_mission DROP COLUMN template_id;
DROP TABLE IF EXISTS athena_gm_template;
DROP TABLE IF EXISTS athena_gm_zone;
