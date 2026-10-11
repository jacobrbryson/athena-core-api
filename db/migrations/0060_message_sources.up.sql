-- Keep the web grounding links alongside the reply they support.
ALTER TABLE message ADD COLUMN sources JSON NULL;
