ALTER TABLE resources DROP CONSTRAINT resources_kind_check;
ALTER TABLE resources ADD CONSTRAINT resources_kind_check CHECK(kind IN ('model','tool','agent','assistant'));
CREATE UNIQUE INDEX one_platform_assistant_per_project ON resources(project_id) WHERE kind='assistant';
CREATE TABLE platform_assistant_settings (
 project_id uuid PRIMARY KEY REFERENCES projects(id), model_id uuid NOT NULL REFERENCES resources(id), updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_assistant_sessions (
 conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 request_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), project_id uuid NOT NULL REFERENCES projects(id),
 context jsonb NOT NULL, UNIQUE(project_id,actor_id,request_id)
);
CREATE TABLE platform_assistant_proposals (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 run_id uuid REFERENCES runs(id) ON DELETE SET NULL, tool_call_id text NOT NULL,
 title text NOT NULL, reason text NOT NULL, actions jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applying','succeeded','failed','dismissed')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour',
 UNIQUE(run_id,tool_call_id)
);
CREATE INDEX assistant_proposals_conversation ON platform_assistant_proposals(conversation_id,created_at);
INSERT INTO schema_migrations(version) VALUES(19);
