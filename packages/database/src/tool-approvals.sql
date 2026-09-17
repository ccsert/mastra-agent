-- Human confirmation gates for write tools. One row per (run, tool call);
-- expiry is decided by the control plane when the row is read past its TTL,
-- so an unanswered gate never silently becomes a decision.
CREATE TABLE run_tool_approvals (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  tool_name text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'expired')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid,
  PRIMARY KEY(run_id, call_id)
);
CREATE INDEX run_tool_approvals_pending ON run_tool_approvals(run_id) WHERE status = 'pending';
INSERT INTO schema_migrations(version) VALUES (25);
