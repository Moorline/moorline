CREATE TABLE IF NOT EXISTS runtime_activities (
  activity_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  session_id TEXT,
  channel_id TEXT,
  source_event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_activities_thread_created
ON runtime_activities(thread_id, created_at);

CREATE TABLE IF NOT EXISTS projection_state (
  projector TEXT PRIMARY KEY,
  last_event_id TEXT,
  last_applied_at TEXT NOT NULL,
  failure TEXT
);
