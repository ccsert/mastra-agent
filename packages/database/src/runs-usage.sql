-- Conversation stats footer reads settled per-run usage without scanning
-- run_events. Both columns are captured when the runtime reports the events.
ALTER TABLE runs ADD COLUMN usage jsonb;
ALTER TABLE runs ADD COLUMN model_ms bigint;
UPDATE runs r SET usage = e.chunk->'data'
  FROM run_events e
 WHERE e.run_id = r.id AND e.chunk->>'type' = 'data-run-usage';
UPDATE runs r SET model_ms = a.total
  FROM (
    SELECT run_id, sum((chunk->'data'->>'durationMs')::bigint) AS total
      FROM run_events WHERE chunk->>'type' = 'data-model-response'
     GROUP BY run_id
  ) a
 WHERE r.id = a.run_id;
INSERT INTO schema_migrations(version) VALUES (24);
