ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member'));
ALTER TABLE users ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD CONSTRAINT users_id_tenant_key UNIQUE(id,tenant_id);
-- Existing users had management access. Keep that access during the one-time migration.
UPDATE users SET role='admin';
UPDATE users SET role='owner' WHERE id IN (SELECT DISTINCT ON (tenant_id) id FROM users ORDER BY tenant_id,id);
CREATE UNIQUE INDEX one_tenant_owner ON users(tenant_id) WHERE role='owner';
CREATE TABLE project_members (
  tenant_id uuid NOT NULL, project_id uuid NOT NULL, user_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('admin','editor','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,user_id),
  FOREIGN KEY(project_id,tenant_id) REFERENCES projects(id,tenant_id),
  FOREIGN KEY(user_id,tenant_id) REFERENCES users(id,tenant_id)
);
CREATE TABLE member_invitations (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), token_hash text UNIQUE NOT NULL,
  label text NOT NULL, project_id uuid, project_role text NOT NULL CHECK(project_role IN ('admin','editor','member','viewer')),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  accepted_at timestamptz, revoked_at timestamptz,
  FOREIGN KEY(project_id,tenant_id) REFERENCES projects(id,tenant_id),
  FOREIGN KEY(created_by,tenant_id) REFERENCES users(id,tenant_id)
);
CREATE TABLE access_audit (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), project_id uuid,
  actor_id uuid NOT NULL, actor_name text NOT NULL, action text NOT NULL, target_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,tenant_id) REFERENCES projects(id,tenant_id)
);
CREATE INDEX access_audit_tenant_created ON access_audit(tenant_id,created_at DESC);
INSERT INTO schema_migrations(version) VALUES (15);
