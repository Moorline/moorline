ALTER TABLE runtime_orchestration_requests ADD COLUMN execution_owner TEXT;
ALTER TABLE runtime_orchestration_requests ADD COLUMN execution_attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runtime_orchestration_requests ADD COLUMN execution_started_at TEXT;
ALTER TABLE runtime_orchestration_requests ADD COLUMN completion_token TEXT;
ALTER TABLE runtime_orchestration_requests ADD COLUMN completed_at TEXT;

UPDATE runtime_orchestration_requests
SET execution_attempt = 0
WHERE execution_attempt IS NULL;

CREATE INDEX IF NOT EXISTS idx_runtime_orchestration_requests_open_claim
ON runtime_orchestration_requests(status, execution_owner, updated_at)
WHERE status IN ('pending', 'running');
