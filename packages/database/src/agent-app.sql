CREATE TABLE assistant_app_registrations (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id),
 url text NOT NULL, manifest jsonb NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX assistant_app_identity ON assistant_app_registrations(project_id,(manifest->>'appId'));
CREATE TABLE assistant_app_sessions (
 conversation_id uuid PRIMARY KEY REFERENCES platform_assistant_sessions(conversation_id) ON DELETE CASCADE,
 registration_id uuid NOT NULL, client_id uuid NOT NULL, page_session_id uuid NOT NULL,
 allow_draft boolean NOT NULL, expires_at timestamptz NOT NULL, view jsonb NOT NULL
);
CREATE TABLE assistant_app_actions (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES platform_assistant_sessions(conversation_id) ON DELETE CASCADE,
 run_id uuid NOT NULL REFERENCES runs(id), tool_call_id text NOT NULL,
 registration_id uuid NOT NULL, client_id uuid NOT NULL, page_session_id uuid NOT NULL,
 input jsonb NOT NULL, request jsonb NOT NULL, view jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','executing','succeeded','failed','cancelled','unknown')),
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '25 seconds',
 UNIQUE(run_id,tool_call_id)
);
CREATE INDEX assistant_app_actions_session ON assistant_app_actions(conversation_id,created_at);
INSERT INTO schema_migrations(version) VALUES(21);
