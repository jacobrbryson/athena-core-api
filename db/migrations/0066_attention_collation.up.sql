-- 0036 created the attention tables without a collation, so they took the
-- server default (utf8mb4_0900_ai_ci) while user_credential is
-- utf8mb4_unicode_ci. MySQL refuses to compare the two, which made the
-- webhook's ownership join (store.receive) throw on every workout event: WHOOP
-- got a 503 for each one from 2026-09-30 and eventually gave up on them.
ALTER TABLE attention_watch CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE attention_event CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE attention_record CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
