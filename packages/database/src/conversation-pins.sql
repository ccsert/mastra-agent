ALTER TABLE conversations ADD COLUMN pinned_at timestamptz;
INSERT INTO schema_migrations(version) VALUES (22);
