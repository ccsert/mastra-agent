CREATE INDEX conversations_page ON conversations(project_id,tenant_id,actor_id,entry,created_at DESC,id DESC);
CREATE INDEX knowledge_documents_page ON knowledge_documents(knowledge_base_id,created_at DESC,id DESC) WHERE status<>'deleted';
CREATE INDEX mcp_imports_tool_contract ON mcp_imports(tool_id,contract_digest);
CREATE INDEX releases_project_catalog ON releases(project_id,tenant_id,created_at DESC,id DESC);
INSERT INTO schema_migrations(version) VALUES(7);
