-- Archived projects stay readable but stop accepting writes and new runs;
-- tenant/project admins keep project.manage so they can restore.
ALTER TABLE projects ADD COLUMN archived_at timestamptz;
INSERT INTO schema_migrations(version) VALUES (27);
