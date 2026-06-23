CREATE TABLE IF NOT EXISTS runtime_workflow_runs (
  run_id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  origin_json TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_workflow_runs_workflow
ON runtime_workflow_runs(package_id, workflow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_workflow_runs_status
ON runtime_workflow_runs(status, updated_at DESC);
