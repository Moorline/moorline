CREATE TABLE IF NOT EXISTS transport_intents (
  intent_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  transport_package_id TEXT,
  type TEXT NOT NULL,
  transport_resource_id TEXT,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  processed_at TEXT,
  failed_at TEXT,
  failure TEXT
);

CREATE INDEX IF NOT EXISTS idx_transport_intents_pending
  ON transport_intents(processed_at, failed_at, occurred_at);

CREATE INDEX IF NOT EXISTS idx_transport_intents_resource
  ON transport_intents(transport_resource_id, occurred_at);
