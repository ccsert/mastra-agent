CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE TABLE IF NOT EXISTS knowledge_bases (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, data jsonb NOT NULL,
 dimensions integer CHECK(dimensions BETWEEN 1 AND 16000), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,tenant_id) REFERENCES projects(id,tenant_id), UNIQUE(id,project_id)
);
CREATE TABLE IF NOT EXISTS knowledge_documents (
 id uuid PRIMARY KEY, knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id),
 filename text NOT NULL, content text NOT NULL, content_hash text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','processing','ready','failed','deleted')),
 job_id uuid NOT NULL, chunk_count integer NOT NULL DEFAULT 0, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,knowledge_base_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_document_content ON knowledge_documents(knowledge_base_id,content_hash) WHERE status<>'deleted';
CREATE TABLE IF NOT EXISTS knowledge_jobs (
 id uuid PRIMARY KEY, knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id),
 actor_id uuid NOT NULL, entry text NOT NULL, runtime_id text NOT NULL REFERENCES runtimes(id),
 kind text NOT NULL CHECK(kind IN ('ingest','search')), document_id uuid,
 input jsonb NOT NULL DEFAULT '{}', snapshot jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 lease_token text, lease_until timestamptz, deadline timestamptz NOT NULL,
 results jsonb NOT NULL DEFAULT '[]', candidates jsonb NOT NULL DEFAULT '[]', error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY(document_id,knowledge_base_id) REFERENCES knowledge_documents(id,knowledge_base_id)
);
CREATE INDEX IF NOT EXISTS knowledge_jobs_claimable ON knowledge_jobs(runtime_id,status,created_at);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
 id uuid PRIMARY KEY, knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id),
 document_id uuid NOT NULL, job_id uuid NOT NULL REFERENCES knowledge_jobs(id), ordinal integer NOT NULL,
 content text NOT NULL, embedding public.vector NOT NULL,
 FOREIGN KEY(document_id,knowledge_base_id) REFERENCES knowledge_documents(id,knowledge_base_id),
 UNIQUE(job_id,ordinal)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_scope ON knowledge_chunks(knowledge_base_id,document_id);
INSERT INTO schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
