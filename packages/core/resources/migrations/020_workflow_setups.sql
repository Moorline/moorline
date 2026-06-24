CREATE TABLE IF NOT EXISTS runtime_workflow_setups (
  setup_id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  origin_json TEXT,
  answers_json TEXT NOT NULL,
  current_question TEXT,
  draft_input_json TEXT,
  draft_summary TEXT,
  run_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_workflow_setups_workflow
ON runtime_workflow_setups(package_id, workflow_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_workflow_setups_status
ON runtime_workflow_setups(status, updated_at DESC);
