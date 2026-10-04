-- A neighbour linked to the person's own Google Contacts entry. Only the
-- People API id is kept (people/c<id> -> <id>); phone, email, address and
-- photo are read from Google each time and never copied here. See
-- services/community.js and docs/capabilities/community.md.
ALTER TABLE athena_neighbor
  ADD COLUMN contact_id VARCHAR(20) NULL AFTER contact;
