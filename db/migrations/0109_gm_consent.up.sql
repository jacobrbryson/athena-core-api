-- Opting in to helping train Athena (docs/capabilities/guardians-missions.md,
-- owner 2026-10-31). She may not contact a Guardian or parent on a mission
-- without this; safety alerts are outside it.
--
-- Terms are immutable: a change is a new version, never an edit, because a
-- person agreed to exact words. The hash is stored on the event as well, so
-- what was agreed can be proven even if a terms row were ever altered.
CREATE TABLE IF NOT EXISTS athena_gm_consent_terms (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version SMALLINT UNSIGNED NOT NULL,
  audience ENUM('adult','parent_for_child','child') NOT NULL,
  title VARCHAR(160) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  body_sha256 CHAR(64) NOT NULL,
  published_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_terms_version (audience, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only: withdrawing adds a row and never touches the agreement before
-- it. role says in what capacity: 'self' for your own agreement, 'parent' for
-- a parent's agreement on behalf of their child. A child needs both.
CREATE TABLE IF NOT EXISTS athena_gm_consent_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  family_id BIGINT NOT NULL,
  subject_actor_id BIGINT UNSIGNED NOT NULL,
  decided_by_actor_id BIGINT UNSIGNED NOT NULL,
  role ENUM('self','parent') NOT NULL,
  action ENUM('agree','withdraw') NOT NULL,
  terms_id BIGINT UNSIGNED NOT NULL,
  terms_sha256 CHAR(64) NOT NULL,
  method ENUM('app_prompt','settings','guardians_app') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_consent_uuid (uuid),
  KEY idx_gm_consent_subject (subject_actor_id, id),
  KEY idx_gm_consent_family (family_id, id),
  CONSTRAINT fk_gm_consent_terms FOREIGN KEY (terms_id) REFERENCES athena_gm_consent_terms (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO athena_gm_consent_terms (version, audience, title, body, body_sha256)
SELECT t.version, t.audience, t.title, t.body, SHA2(t.body, 256)
FROM (
  SELECT 1 version, 'adult' audience, 'Helping train Athena' title,
'Athena is learning. Guardians missions are how she tests what she can do and gains new abilities. By agreeing, you choose to take part in that.

What this means:
- Athena may contact you about missions by notification, text, email or in the app, and may ask you to do things such as taking photos or confirming a step.
- She keeps a record of each message: who it was with, how it was sent and when.
- She keeps the results of missions, and may record what you can do, such as which skills you have.
- Photos you send for a mission, with their location and compass direction, are kept in private storage and are sent to Google''s Gemini service so Athena can look at them.
- If voice recognition is added, she may store a voiceprint so she can tell who is speaking. It is encrypted, is never put in front of an AI model, and can never approve anything.

Your choices:
- You can leave at any time, for any reason, and nothing bad happens. Leaving stops mission contact, cancels anything waiting to be sent to you and deletes your voiceprint.
- Mission records from before you left are kept unless you ask for them to be removed.
- Safety alerts, such as a freeze warning or a nearby emergency, are separate and do not depend on this agreement.
- If these terms change in a way that matters, Athena will stop mission contact until you agree again.' body
  UNION ALL SELECT 1, 'parent_for_child', 'Letting your child help train Athena',
'Athena is learning. Guardians missions are how she tests what she can do and gains new abilities. By agreeing, you allow your child to take part, and your child will be asked to agree too. Both of you must agree.

What this means:
- Athena may contact your child about missions through the Guardians app or a device you set up, and may ask them to do real-world tasks such as finding clues or taking photos.
- She keeps a record of each message: who it was with, how it was sent and when.
- She keeps the results of missions, and may record what your child can do, such as reading Morse code.
- Photos your child sends for a mission may show your child, and are kept in private storage with their location and compass direction. They are sent to Google''s Gemini service so Athena can look at them.
- If voice recognition is added, she may store a voiceprint of your child so she can tell who is speaking. It is encrypted, is never put in front of an AI model, and can never approve anything.
- A parent approves each mission plan before it can start.

Your choices:
- You or your child can leave at any time, for any reason, and nothing bad happens. Either one leaving stops mission contact with your child right away, cancels anything waiting to be sent and deletes their voiceprint.
- Mission records from before leaving are kept unless you ask for them to be removed.
- If these terms change in a way that matters, Athena will stop mission contact until you and your child agree again.'
  UNION ALL SELECT 1, 'child', 'Do you want to help train Athena?',
'Athena is still learning, and missions are how she gets better. You can help her if you want to.

If you say yes:
- Athena can send you messages about missions and ask you to do things, like finding clues or taking pictures.
- She remembers what happened on missions and what you are good at.
- Pictures you send her are kept private. A computer service from Google helps her look at them. Pictures can show where you were.

It is your choice:
- A parent has to say yes too.
- You can stop any time, for any reason. Nobody will be upset, and you will not get in trouble.
- If anything feels wrong or unsafe, stop and tell a grown-up.'
) t
ON DUPLICATE KEY UPDATE id = id;
