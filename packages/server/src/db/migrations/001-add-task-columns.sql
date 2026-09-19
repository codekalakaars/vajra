-- Add missing columns to the tasks table that TaskState carries but the
-- original schema omitted. Each column is added with a separate ALTER TABLE
-- because SQLite does not support multiple ADD COLUMN in a single statement.
-- The IF NOT EXISTS clause is handled in code (not SQL) since SQLite < 3.37
-- does not support it on ALTER TABLE.

ALTER TABLE tasks ADD COLUMN instructions TEXT;
ALTER TABLE tasks ADD COLUMN read_file TEXT;
ALTER TABLE tasks ADD COLUMN write_file TEXT;
ALTER TABLE tasks ADD COLUMN delete_file TEXT;
ALTER TABLE tasks ADD COLUMN create_dir TEXT;
ALTER TABLE tasks ADD COLUMN validation TEXT;
ALTER TABLE tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'modify';
ALTER TABLE tasks ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 2;
ALTER TABLE tasks ADD COLUMN timeout INTEGER NOT NULL DEFAULT 120;
ALTER TABLE tasks ADD COLUMN rollback TEXT;
ALTER TABLE tasks ADD COLUMN skip_if TEXT;
