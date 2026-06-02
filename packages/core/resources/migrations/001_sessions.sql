CREATE TABLE IF NOT EXISTS runtime_sessions (
  session_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  transport_resource_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL UNIQUE,
  transport_resource_name TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  runtime_mode TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  summary TEXT,
  provider TEXT NOT NULL,
  provider_thread_id TEXT,
  resume_thread_id TEXT,
  provider_status TEXT NOT NULL,
  active_turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  archived_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS runtime_events (
  event_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  transport_resource_id TEXT,
  turn_id TEXT,
  item_id TEXT,
  request_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_thread_created
ON runtime_events(thread_id, created_at);

CREATE TABLE IF NOT EXISTS pending_runtime_requests (
  request_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  transport_resource_id TEXT NOT NULL,
  request_type TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  questions_json TEXT,
  decision TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_runtime_requests_resource_status
ON pending_runtime_requests(transport_resource_id, status, created_at);

CREATE TABLE IF NOT EXISTS runtime_metadata (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
