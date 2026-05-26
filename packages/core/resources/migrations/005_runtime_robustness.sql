ALTER TABLE provider_bindings ADD COLUMN runtime_payload_json TEXT;
ALTER TABLE provider_bindings ADD COLUMN capability_metadata_json TEXT;
ALTER TABLE runtime_events ADD COLUMN provider TEXT NOT NULL DEFAULT 'provider';
