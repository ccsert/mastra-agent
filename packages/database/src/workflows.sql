CREATE TABLE workflows (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES projects(id), data jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1, current_release_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workflow_releases (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES projects(id), workflow_id uuid NOT NULL REFERENCES workflows(id),
 name text NOT NULL, version integer NOT NULL, digest text NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workflow_id,version)
);
ALTER TABLE workflows ADD FOREIGN KEY (current_release_id) REFERENCES workflow_releases(id);
CREATE TABLE workflow_jobs (
 id uuid PRIMARY KEY, workflow_id uuid NOT NULL REFERENCES workflows(id), tenant_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES projects(id),
 actor_id uuid NOT NULL, entry text NOT NULL, kind text NOT NULL CHECK(kind IN ('execute','generate')), release_id uuid REFERENCES workflow_releases(id),
 snapshot jsonb NOT NULL, input jsonb NOT NULL, output jsonb, request_id text NOT NULL, request_hash text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')), runtime_id text NOT NULL REFERENCES runtimes(id),
 lease_token uuid, lease_until timestamptz, deadline timestamptz NOT NULL, error_code text,
 candidate jsonb, issues jsonb NOT NULL DEFAULT '[]', attempts integer NOT NULL DEFAULT 0, accepted_revision integer,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 CHECK ((kind='execute') = (release_id IS NOT NULL)), UNIQUE(workflow_id,actor_id,entry,kind,request_id)
);
CREATE INDEX workflow_jobs_claim ON workflow_jobs(runtime_id,status,created_at);
CREATE TABLE workflow_node_runs (
 job_id uuid NOT NULL REFERENCES workflow_jobs(id), node_id text NOT NULL, label text NOT NULL, type text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped')),
 input jsonb, output jsonb, error_code text, started_at timestamptz, finished_at timestamptz, PRIMARY KEY(job_id,node_id)
);
INSERT INTO schema_migrations(version) VALUES(4);
