CREATE TABLE task_artifacts (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL,
  name text NOT NULL,
  media_type text NOT NULL,
  sha256 text NOT NULL,
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,tool_call_id,sha256)
);
CREATE INDEX task_artifacts_run ON task_artifacts(run_id);
INSERT INTO schema_migrations(version) VALUES(12);
