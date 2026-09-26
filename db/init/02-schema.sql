-- Local read model of Keycloak identities (ADR 0002): upserted by the api from the JWT
-- on every authenticated request, so follows and feeds can join on usernames.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, -- Keycloak `sub`
  username TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- text_pattern_ops lets `username LIKE 'ali%'` (user search) use the index.
CREATE INDEX IF NOT EXISTS users_username_prefix_idx ON users (username text_pattern_ops);

CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploaded', 'processing', 'ready', 'infected', 'failed')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
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
-- Feed (fan-out on read): per followed owner, their Published files newest first.
-- Partial, so private and unfinished files don't take space in it.
CREATE INDEX IF NOT EXISTS files_published_owner_created_idx
  ON files (owner_id, created_at DESC, id DESC) WHERE visibility = 'public' AND status = 'ready';

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT follows_not_self CHECK (follower_id <> followee_id)
);

-- The PK serves "whom do I follow"; this serves "who follows X" (follower counts).
CREATE INDEX IF NOT EXISTS follows_followee_idx ON follows (followee_id);

-- The PK makes a like idempotent: the second insert of the same pair is a no-op.
CREATE TABLE IF NOT EXISTS likes (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, file_id)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  -- W3C trace context of the request that wrote the row. The relay publishes later from a
  -- timer with no request context, so the trace must travel with the data. NULL = no trace.
  traceparent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS outbox_unpublished_idx
  ON outbox_events (id) WHERE published_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON users TO api_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON files TO api_user;
GRANT SELECT, INSERT, DELETE ON follows TO api_user;
GRANT SELECT, INSERT, DELETE ON likes TO api_user;
GRANT SELECT, UPDATE ON files TO processor_user;
GRANT SELECT, INSERT, UPDATE ON outbox_events TO api_user;
GRANT USAGE, SELECT ON SEQUENCE outbox_events_id_seq TO api_user;
