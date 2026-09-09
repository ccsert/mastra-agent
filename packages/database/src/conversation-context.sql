ALTER TABLE runs ADD COLUMN input_text text;
ALTER TABLE runs ADD COLUMN skill_version_ids jsonb NOT NULL DEFAULT '[]';
CREATE INDEX runs_conversation_page_idx ON runs(conversation_id,created_at DESC,id DESC);
INSERT INTO schema_migrations(version) VALUES(8);
