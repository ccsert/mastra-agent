ALTER TABLE skill_versions ADD COLUMN source jsonb;
CREATE TABLE skill_import_previews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  preview jsonb NOT NULL,
  archive bytea,
  result_version_id uuid REFERENCES skill_versions(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skill_import_previews_expiry_idx ON skill_import_previews(expires_at);
CREATE INDEX skill_import_previews_actor_idx ON skill_import_previews(project_id,actor_id,created_at);
INSERT INTO schema_migrations(version) VALUES(17);
