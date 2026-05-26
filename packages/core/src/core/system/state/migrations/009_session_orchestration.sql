ALTER TABLE runtime_sessions ADD COLUMN owner_kind TEXT;
ALTER TABLE runtime_sessions ADD COLUMN owner_id TEXT;
ALTER TABLE runtime_sessions ADD COLUMN owner_label TEXT;
ALTER TABLE runtime_sessions ADD COLUMN objective TEXT;
ALTER TABLE runtime_sessions ADD COLUMN tags_json TEXT;
ALTER TABLE runtime_sessions ADD COLUMN created_by TEXT;
ALTER TABLE runtime_sessions ADD COLUMN last_directed_at TEXT;
ALTER TABLE runtime_sessions ADD COLUMN last_directed_by TEXT;

CREATE TABLE IF NOT EXISTS runtime_orchestration_requests (
  request_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  requested_by_thread_id TEXT NOT NULL,
  requested_by_channel_id TEXT NOT NULL,
  type TEXT NOT NULL,
  target_session_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_orchestration_requests_status_created
ON runtime_orchestration_requests(status, created_at);
