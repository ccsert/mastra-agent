ALTER TABLE runs ADD COLUMN context_action text CHECK(context_action = 'compact');
ALTER TABLE runs ADD COLUMN context_through bigint;
CREATE TABLE conversation_summaries (
 conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 through_position bigint NOT NULL, summary text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE conversation_resets (
 source_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 request_id uuid NOT NULL, conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 PRIMARY KEY(source_id, request_id)
);
CREATE TABLE assistant_ui_sessions (
 conversation_id uuid PRIMARY KEY REFERENCES platform_assistant_sessions(conversation_id) ON DELETE CASCADE,
 client_id uuid NOT NULL, expires_at timestamptz NOT NULL,
 view jsonb NOT NULL
);
CREATE TABLE assistant_ui_actions (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES platform_assistant_sessions(conversation_id) ON DELETE CASCADE,
 run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE, tool_call_id text NOT NULL,
 client_id uuid NOT NULL, input jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','executing','succeeded','failed')),
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '30 seconds',
 UNIQUE(run_id, tool_call_id)
);
CREATE INDEX assistant_ui_pending ON assistant_ui_actions(conversation_id, created_at) WHERE status IN ('pending','executing');
INSERT INTO schema_migrations(version) VALUES(20);
