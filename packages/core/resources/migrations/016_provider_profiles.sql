ALTER TABLE runtime_sessions ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE runtime_sessions ADD COLUMN provider_cwd TEXT;
ALTER TABLE runtime_sessions ADD COLUMN resume_cursor_json TEXT;
ALTER TABLE runtime_sessions ADD COLUMN tool_grant_ids_json TEXT NOT NULL DEFAULT '[]';
