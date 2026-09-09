CREATE TABLE skill_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  digest text NOT NULL,
  archive_hash text NOT NULL,
  archive bytea NOT NULL,
  manifest jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name, version),
  UNIQUE(project_id, name, digest)
);
CREATE TABLE skill_files (
  version_id uuid NOT NULL REFERENCES skill_versions(id),
  path text NOT NULL,
  content bytea NOT NULL,
  PRIMARY KEY(version_id,path)
);
CREATE INDEX skill_versions_project_idx ON skill_versions(project_id,created_at DESC,id DESC);
INSERT INTO schema_migrations(version) VALUES(6);
