ALTER TABLE runtime_sessions RENAME COLUMN guild_id TO scope_id;
ALTER TABLE runtime_sessions RENAME COLUMN channel_id TO space_id;
ALTER TABLE runtime_sessions RENAME COLUMN channel_name TO space_name;

ALTER TABLE runtime_missions RENAME COLUMN guild_id TO scope_id;
ALTER TABLE runtime_missions RENAME COLUMN channel_id TO space_id;
ALTER TABLE runtime_missions RENAME COLUMN channel_name TO space_name;

ALTER TABLE runtime_events RENAME COLUMN channel_id TO space_id;
ALTER TABLE domain_events RENAME COLUMN channel_id TO space_id;
ALTER TABLE runtime_receipts RENAME COLUMN channel_id TO space_id;
ALTER TABLE runtime_activities RENAME COLUMN channel_id TO space_id;
ALTER TABLE pending_runtime_requests RENAME COLUMN channel_id TO space_id;

ALTER TABLE runtime_orchestration_requests RENAME COLUMN requested_by_channel_id TO requested_by_space_id;

DROP INDEX IF EXISTS idx_pending_runtime_requests_channel_status;
CREATE INDEX IF NOT EXISTS idx_pending_runtime_requests_space_status
  ON pending_runtime_requests(space_id, status, created_at);
