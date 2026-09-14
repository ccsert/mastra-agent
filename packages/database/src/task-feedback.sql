CREATE TABLE task_feedback (
  position bigserial UNIQUE NOT NULL,
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE(run_id, request_id)
);
CREATE INDEX task_feedback_run ON task_feedback(run_id, position);
INSERT INTO schema_migrations(version) VALUES(14);
