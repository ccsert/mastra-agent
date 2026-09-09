CREATE INDEX workflows_page ON workflows(project_id,tenant_id,created_at DESC,id DESC);
CREATE INDEX runs_page ON runs(project_id,actor_id,entry,created_at DESC,id DESC);
CREATE INDEX workflow_jobs_page ON workflow_jobs(workflow_id,project_id,actor_id,entry,kind,created_at DESC,id DESC);
CREATE INDEX mcp_discoveries_page ON mcp_discoveries(server_id,created_at DESC,id DESC);
INSERT INTO schema_migrations(version) VALUES(5);
