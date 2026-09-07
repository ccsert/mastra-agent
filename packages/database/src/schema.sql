CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS tenants (id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), username text UNIQUE NOT NULL, display_name text NOT NULL, password_hash text NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL, description text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,tenant_id));
CREATE TABLE IF NOT EXISTS resources (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('model','tool','agent')),
 data jsonb NOT NULL, secret_enc text NOT NULL DEFAULT '', revision integer NOT NULL DEFAULT 1, current_release_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(project_id,tenant_id) REFERENCES projects(id,tenant_id), UNIQUE(id,project_id)
);
CREATE INDEX IF NOT EXISTS resources_project_kind ON resources(project_id,kind);
CREATE TABLE IF NOT EXISTS releases (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, agent_id uuid NOT NULL, version integer NOT NULL,
 digest text NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(agent_id,project_id) REFERENCES resources(id,project_id), UNIQUE(agent_id,version), UNIQUE(id,project_id)
);
CREATE TABLE IF NOT EXISTS applications (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, name text NOT NULL, access_key text UNIQUE NOT NULL, secret_enc text NOT NULL, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(project_id,tenant_id) REFERENCES projects(id,tenant_id));
CREATE TABLE IF NOT EXISTS auth_nonces (application_id uuid NOT NULL REFERENCES applications(id), nonce text NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(application_id,nonce));
CREATE TABLE IF NOT EXISTS conversations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, actor_id uuid NOT NULL, entry text NOT NULL,
 agent_id uuid NOT NULL, release_id uuid NOT NULL, title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(release_id,project_id) REFERENCES releases(id,project_id), UNIQUE(id,project_id)
);
CREATE INDEX IF NOT EXISTS conversations_owner ON conversations(project_id,actor_id,entry);
CREATE TABLE IF NOT EXISTS messages (id text PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id), data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), position bigint GENERATED ALWAYS AS IDENTITY);
CREATE TABLE IF NOT EXISTS runtimes (id text PRIMARY KEY, name text NOT NULL, last_seen_at timestamptz);
CREATE TABLE IF NOT EXISTS runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, actor_id uuid NOT NULL, entry text NOT NULL,
 conversation_id uuid NOT NULL, release_id uuid NOT NULL REFERENCES releases(id), request_id text NOT NULL, input_hash text NOT NULL,
 runtime_id text NOT NULL REFERENCES runtimes(id), status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 lease_token text, lease_until timestamptz, deadline timestamptz NOT NULL, cancel_requested boolean NOT NULL DEFAULT false,
 error_code text, output_text text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY(conversation_id,project_id) REFERENCES conversations(id,project_id), UNIQUE(conversation_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_conversation ON runs(conversation_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS runs_claimable ON runs(runtime_id,status,created_at);
CREATE TABLE IF NOT EXISTS run_events (run_id uuid NOT NULL REFERENCES runs(id), seq integer NOT NULL, chunk jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,seq));
INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
