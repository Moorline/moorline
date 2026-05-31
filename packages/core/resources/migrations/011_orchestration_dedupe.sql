ALTER TABLE runtime_orchestration_requests ADD COLUMN dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_orchestration_requests_dedupe_open
ON runtime_orchestration_requests(dedupe_key)
WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running');
