DROP TABLE IF EXISTS memory_extraction_cursor;
DROP TABLE IF EXISTS memory_embedding;
ALTER TABLE user_memory DROP INDEX ft_user_memory;
DROP TABLE IF EXISTS memory_event;
