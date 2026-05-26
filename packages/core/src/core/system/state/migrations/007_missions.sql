CREATE TABLE IF NOT EXISTS runtime_missions (
  mission_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL UNIQUE,
  channel_name TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  schedule_text TEXT NOT NULL,
  cadence_minutes INTEGER NOT NULL,
  runtime_mode TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  paused_at TEXT,
  last_run_at TEXT,
  next_run_at TEXT,
  last_success_at TEXT,
  completed_at TEXT,
  stopped_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_missions_next_run
ON runtime_missions(next_run_at, lifecycle_status);

CREATE TABLE IF NOT EXISTS runtime_mission_runs (
  run_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  summary TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (mission_id) REFERENCES runtime_missions(mission_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runtime_mission_runs_mission_started
ON runtime_mission_runs(mission_id, started_at DESC);
