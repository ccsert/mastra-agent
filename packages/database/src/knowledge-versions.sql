CREATE TABLE knowledge_document_versions (
 id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES knowledge_documents(id),
 version integer NOT NULL CHECK(version>0), job_id uuid NOT NULL UNIQUE,
 filename text NOT NULL, content text NOT NULL, content_hash text NOT NULL,
 format text NOT NULL, byte_size integer NOT NULL, original bytea,
 sections jsonb NOT NULL DEFAULT '[]', plan jsonb NOT NULL DEFAULT '[]', warnings jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL CHECK(status IN ('queued','processing','ready','failed')),
 chunk_count integer NOT NULL DEFAULT 0, indexed_count integer NOT NULL DEFAULT 0, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(document_id,version), UNIQUE(id,document_id)
);
ALTER TABLE knowledge_documents ADD COLUMN active_version_id uuid;
ALTER TABLE knowledge_documents ADD COLUMN latest_version_id uuid;
ALTER TABLE knowledge_chunks ADD COLUMN location jsonb;
INSERT INTO knowledge_document_versions(id,document_id,version,job_id,filename,content,content_hash,format,byte_size,original,sections,status,chunk_count,indexed_count,error_code,created_at)
 SELECT job_id,id,1,job_id,filename,content,content_hash,CASE WHEN lower(filename) LIKE '%.md' THEN 'md' ELSE 'txt' END,
 octet_length(content),convert_to(content,'UTF8'),jsonb_build_array(jsonb_build_object('location',jsonb_build_object('kind','paragraph','index',1),'content',content)),
 status,chunk_count,chunk_count,error_code,created_at FROM knowledge_documents WHERE status<>'deleted';
UPDATE knowledge_documents SET latest_version_id=job_id,active_version_id=CASE WHEN status='ready' THEN job_id ELSE NULL END WHERE status<>'deleted';
ALTER TABLE knowledge_documents ADD FOREIGN KEY(latest_version_id,id) REFERENCES knowledge_document_versions(id,document_id);
ALTER TABLE knowledge_documents ADD FOREIGN KEY(active_version_id,id) REFERENCES knowledge_document_versions(id,document_id);
CREATE TABLE knowledge_document_previews (
 id uuid PRIMARY KEY, knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id), actor_id uuid NOT NULL,
 document_id uuid REFERENCES knowledge_documents(id), base_version uuid, parsed jsonb NOT NULL, original bytea,
 result_document_id uuid REFERENCES knowledge_documents(id), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_preview_scope ON knowledge_document_previews(knowledge_base_id,actor_id,created_at);
INSERT INTO schema_migrations(version) VALUES(18);
