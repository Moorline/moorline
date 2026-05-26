ALTER TABLE runtime_missions ADD COLUMN schedule_anchor_at TEXT;

UPDATE runtime_missions
SET schedule_anchor_at = COALESCE(schedule_anchor_at, created_at)
WHERE schedule_anchor_at IS NULL;
