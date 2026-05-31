CREATE TABLE IF NOT EXISTS runtime_package_state (
  package_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (package_id, key)
);

CREATE INDEX IF NOT EXISTS idx_runtime_package_state_package_key
ON runtime_package_state(package_id, key);

CREATE TABLE IF NOT EXISTS runtime_package_jobs (
  package_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  schedule_text TEXT NOT NULL,
  schedule_anchor_at TEXT NOT NULL,
  cadence_minutes INTEGER NOT NULL,
  schedule_meta_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (package_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_package_jobs_next_run
ON runtime_package_jobs(next_run_at);
