ALTER TABLE runtime_missions ADD COLUMN schedule_meta_json TEXT;

UPDATE runtime_missions
SET schedule_meta_json =
  CASE
    WHEN cadence_minutes > 0 THEN '{"kind":"interval","intervalMinutes":' || cadence_minutes || '}'
    ELSE NULL
  END
WHERE schedule_meta_json IS NULL;
