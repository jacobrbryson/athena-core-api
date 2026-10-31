DELETE a FROM athena_gm_actor a
JOIN family_members m ON m.family_id = a.family_id AND m.display_name = 'Jenny Wolfer' AND m.role = 'owner'
WHERE a.actor_key IN ('jenny', 'lena', 'livia');
DELETE c FROM athena_gm_control c
JOIN family_members m ON m.family_id = c.family_id AND m.display_name = 'Jenny Wolfer' AND m.role = 'owner';
ALTER TABLE athena_gm_actor DROP COLUMN guardian_credential_id;
DROP TABLE IF EXISTS athena_gm_voiceprint;
DROP TABLE IF EXISTS athena_gm_contact_event;
DROP TABLE IF EXISTS athena_gm_contact_point;
