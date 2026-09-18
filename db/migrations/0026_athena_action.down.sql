-- Reverse of 0026_athena_action.
--
-- Dropping these loses the audit trail of everything Athena did on the
-- person's behalf. Export athena_action before running this in production.
DROP TABLE IF EXISTS athena_action_authority;
DROP TABLE IF EXISTS athena_action;
