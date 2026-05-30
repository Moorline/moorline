CREATE TABLE IF NOT EXISTS provider_bindings (
  thread_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  runtime_mode TEXT NOT NULL,
  cwd TEXT NOT NULL,
  provider_thread_id TEXT,
  status TEXT NOT NULL,
  model TEXT,
  account_label TEXT,
  available_models_json TEXT,
  updated_at TEXT NOT NULL,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS runtime_receipts (
  thread_id TEXT PRIMARY KEY,
  session_id TEXT,
  space_id TEXT,
  active_turn_id TEXT,
  state TEXT NOT NULL,
  wait_reason TEXT,
  pending_request_id TEXT,
  last_assistant_text TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_events (
  event_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  space_id TEXT,
  session_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_domain_events_thread_created
ON domain_events(thread_id, created_at);
