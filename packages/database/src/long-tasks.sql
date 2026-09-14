ALTER TABLE runs ADD COLUMN recovery_count integer NOT NULL DEFAULT 0;
CREATE TABLE agent_workflow_snapshots (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  workflow_name text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id, workflow_name)
);
CREATE TABLE run_model_reservations (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  estimated_tokens integer NOT NULL CHECK (estimated_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id, request_id)
);
CREATE TABLE run_tool_receipts (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
  output jsonb,
  error_code text,
  PRIMARY KEY(run_id,call_id)
);
CREATE TABLE conversation_task_state (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  run_id uuid NOT NULL REFERENCES runs(id),
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES(11);
