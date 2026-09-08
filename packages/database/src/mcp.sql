CREATE TABLE mcp_servers (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL,
 name text NOT NULL, url text NOT NULL, secret_enc text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,tenant_id) REFERENCES projects(id,tenant_id), UNIQUE(id,project_id)
);
CREATE TABLE mcp_discoveries (
 id uuid PRIMARY KEY, server_id uuid NOT NULL REFERENCES mcp_servers(id), runtime_id text NOT NULL REFERENCES runtimes(id),
 status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 tools jsonb NOT NULL DEFAULT '[]', lease_token text, lease_until timestamptz, deadline timestamptz NOT NULL,
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX mcp_discoveries_server ON mcp_discoveries(server_id,created_at DESC);
CREATE UNIQUE INDEX mcp_one_discovery ON mcp_discoveries(server_id) WHERE status IN ('queued','running');
CREATE TABLE mcp_imports (
 server_id uuid NOT NULL REFERENCES mcp_servers(id), remote_name text NOT NULL, contract_digest text NOT NULL, platform_name text NOT NULL,
 tool_id uuid NOT NULL REFERENCES resources(id), discovery_id uuid NOT NULL REFERENCES mcp_discoveries(id),
 reviewed_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(server_id,remote_name,contract_digest,platform_name)
);
INSERT INTO schema_migrations(version) VALUES (3);
