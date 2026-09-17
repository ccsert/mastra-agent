-- Per-conversation write-tool mode: readonly refuses without prompting, ask
-- pauses for a person per call, auto runs gated tools without asking.
ALTER TABLE conversations ADD COLUMN approval_policy text NOT NULL DEFAULT 'ask'
  CHECK (approval_policy IN ('readonly', 'ask', 'auto'));
INSERT INTO schema_migrations(version) VALUES (26);
