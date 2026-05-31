CREATE TABLE IF NOT EXISTS managed_sidecars (
  sidecar_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  sidecar_name TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  status TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  env_json TEXT NOT NULL,
  restart_policy TEXT NOT NULL,
  max_restarts INTEGER NOT NULL DEFAULT 0,
  readiness_json TEXT NOT NULL,
  artifact_dir TEXT NOT NULL,
  pid INTEGER,
  restart_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  ready_at TEXT,
  stopped_at TEXT,
  last_exit_code INTEGER,
  last_exit_signal TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_managed_sidecars_scope
  ON managed_sidecars(scope_kind, scope_key, plugin_id, sidecar_name);
