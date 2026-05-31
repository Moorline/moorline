CREATE TABLE IF NOT EXISTS provider_event_processing (
  event_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

INSERT OR IGNORE INTO provider_event_processing (event_id, processed_at)
SELECT event_id, created_at
FROM runtime_events;
