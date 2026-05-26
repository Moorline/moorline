CREATE TABLE IF NOT EXISTS runtime_mission_hook_bindings (
  binding_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  hook_key TEXT NOT NULL,
  condition_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES runtime_missions(mission_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runtime_mission_hook_bindings_hook
ON runtime_mission_hook_bindings(hook_key, mission_id, created_at);

CREATE INDEX IF NOT EXISTS idx_runtime_mission_hook_bindings_mission
ON runtime_mission_hook_bindings(mission_id, hook_key, created_at);
