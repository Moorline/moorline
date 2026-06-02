CREATE TABLE IF NOT EXISTS runtime_external_resources (
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT,
  title TEXT,
  state TEXT,
  metadata_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (provider, kind, external_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_external_resources_seen
ON runtime_external_resources(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS runtime_work_items (
  work_item_id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  queue TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL,
  idempotency_key TEXT,
  external_provider TEXT,
  external_kind TEXT,
  external_id TEXT,
  external_url TEXT,
  external_title TEXT,
  external_metadata_json TEXT,
  session_id TEXT,
  payload_json TEXT NOT NULL,
  phase TEXT,
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  run_after TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_work_items_idempotency
ON runtime_work_items(package_id, queue, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runtime_work_items_claim
ON runtime_work_items(package_id, queue, status, run_after, priority DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_runtime_work_items_resource
ON runtime_work_items(external_provider, external_kind, external_id);

CREATE TABLE IF NOT EXISTS runtime_session_external_resources (
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  relationship TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, provider, kind, external_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_session_external_resources_resource
ON runtime_session_external_resources(provider, kind, external_id);

CREATE TABLE IF NOT EXISTS runtime_gate_runs (
  gate_run_id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  work_item_id TEXT,
  session_id TEXT,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL,
  cwd TEXT,
  required INTEGER NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  stdout TEXT NOT NULL,
  stderr TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_gate_runs_work_item
ON runtime_gate_runs(work_item_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_gate_runs_session
ON runtime_gate_runs(session_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_gate_runs_recent
ON runtime_gate_runs(started_at DESC);
