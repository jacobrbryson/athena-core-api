-- A picture of each dream: gs:// path of the image the nightly job painted
-- from the dream's retelling (services/dreams/image.js). The object lives in
-- the private athena-dreams bucket and is served through the API; the bucket's
-- lifecycle rule deletes it after 30 days, matching the Dreams log.
ALTER TABLE athena_dream
  ADD COLUMN image_path VARCHAR(255) NULL AFTER narrative,
  ADD COLUMN image_model VARCHAR(80) NULL AFTER image_path;
