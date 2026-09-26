CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploaded', 'processing', 'ready', 'infected', 'failed')),
  object_key TEXT NOT NULL,
  thumbnail_key TEXT,
  checksum TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS files_owner_created_idx ON files (owner_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS files_owner_idempotency_idx
  ON files (owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS outbox_unpublished_idx
  ON outbox_events (id) WHERE published_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON files TO api_user;
GRANT SELECT, UPDATE ON files TO processor_user;
GRANT SELECT, INSERT, UPDATE ON outbox_events TO api_user;
GRANT USAGE, SELECT ON SEQUENCE outbox_events_id_seq TO api_user;
