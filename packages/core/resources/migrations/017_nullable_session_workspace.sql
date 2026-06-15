CREATE TABLE runtime_sessions_next (
  session_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  transport_resource_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL UNIQUE,
  transport_resource_name TEXT NOT NULL,
  agent_kind TEXT NOT NULL DEFAULT 'workspace',
  workspace_path TEXT,
  provider_cwd TEXT,
  runtime_mode TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  summary TEXT,
  provider TEXT NOT NULL,
  provider_thread_id TEXT,
  resume_cursor_json TEXT,
  tool_grant_ids_json TEXT NOT NULL DEFAULT '[]',
  provider_status TEXT NOT NULL,
  provider_auto_start_enabled INTEGER NOT NULL DEFAULT 1,
  active_turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  archived_at TEXT,
  last_error TEXT,
  owner_kind TEXT,
  owner_id TEXT,
  owner_label TEXT,
  objective TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  last_directed_at TEXT,
  last_directed_by TEXT
);

INSERT INTO runtime_sessions_next (
  session_id, scope_id, transport_resource_id, thread_id, transport_resource_name, agent_kind, workspace_path, provider_cwd,
  runtime_mode, lifecycle_status, summary, provider, provider_thread_id, resume_cursor_json, tool_grant_ids_json,
  provider_status, provider_auto_start_enabled, active_turn_id, created_at, updated_at, last_activity_at, archived_at, last_error,
  owner_kind, owner_id, owner_label, objective, tags_json, created_by, last_directed_at, last_directed_by
)
SELECT
  session_id, scope_id, transport_resource_id, thread_id, transport_resource_name, COALESCE(agent_kind, 'workspace'), workspace_path, provider_cwd,
  runtime_mode, lifecycle_status, summary, provider, provider_thread_id, resume_cursor_json, COALESCE(tool_grant_ids_json, '[]'),
  provider_status, COALESCE(provider_auto_start_enabled, 1), active_turn_id, created_at, updated_at, last_activity_at, archived_at, last_error,
  owner_kind, owner_id, owner_label, objective, COALESCE(tags_json, '[]'), created_by, last_directed_at, last_directed_by
FROM runtime_sessions;

DROP TABLE runtime_sessions;
ALTER TABLE runtime_sessions_next RENAME TO runtime_sessions;
