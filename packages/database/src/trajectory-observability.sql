-- Runtime-reported time for each persisted stream event.
-- Old rows keep NULL: the reader falls back to the control-plane receipt time and
-- labels which of the two it is showing. Nothing is backfilled or recomputed.
ALTER TABLE run_events ADD COLUMN occurred_at timestamptz;
INSERT INTO schema_migrations(version) VALUES(9);
