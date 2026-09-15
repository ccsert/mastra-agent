ALTER TABLE runtimes ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE runtimes ADD COLUMN token_hash text;
INSERT INTO schema_migrations(version) VALUES (23);
