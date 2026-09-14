ALTER TABLE conversations ADD COLUMN parent_conversation_id uuid;
ALTER TABLE conversations ADD COLUMN parent_message_id text;
ALTER TABLE conversations ADD COLUMN branch_request_id text;
ALTER TABLE conversations ADD COLUMN branch_input_hash text;
CREATE UNIQUE INDEX conversation_branch_request ON conversations(parent_conversation_id,branch_request_id) WHERE branch_request_id IS NOT NULL;
INSERT INTO schema_migrations(version) VALUES (10);
