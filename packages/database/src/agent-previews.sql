ALTER TABLE releases ADD COLUMN kind text NOT NULL DEFAULT 'published' CHECK(kind IN ('published','preview'));
ALTER TABLE releases ADD COLUMN source_revision integer;
ALTER TABLE releases ADD COLUMN preview_actor_id uuid;
ALTER TABLE releases ADD COLUMN preview_request_id uuid;
ALTER TABLE releases DROP CONSTRAINT releases_agent_id_version_key;
CREATE UNIQUE INDEX releases_published_version ON releases(agent_id,version) WHERE kind='published';
CREATE UNIQUE INDEX releases_preview_request ON releases(project_id,preview_actor_id,preview_request_id) WHERE kind='preview';
ALTER TABLE releases ADD CONSTRAINT releases_preview_scope CHECK(
  (kind='published' AND version>0 AND preview_actor_id IS NULL AND preview_request_id IS NULL)
  OR (kind='preview' AND version=0 AND preview_actor_id IS NOT NULL AND preview_request_id IS NOT NULL AND source_revision IS NOT NULL)
);
INSERT INTO schema_migrations(version) VALUES (16);
