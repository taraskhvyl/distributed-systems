#!/usr/bin/env bash
# Experiment: how the fan-out-on-read feed query scales with the number of people you follow.
# Seeds 1000 users with 20 Published files each (+ private files as noise), then runs
# EXPLAIN ANALYZE on the feed query for a viewer following 3 users, then 1000.
# Usage: scripts/experiment-feed-plan.sh   (stack must be up; cleans up after itself)
set -euo pipefail

AUTHORS=1000
PUBLISHED_PER_AUTHOR=20
PRIVATE_FILES=50000
VIEWER=feed-viewer
PSQL=(docker compose exec -T postgres psql -U postgres -d mediashare -v ON_ERROR_STOP=1 -qtA)

# Mirrors readFeed() + FILE_VIEW_SELECT in services/api/src (first page, no cursor).
FEED_QUERY="
  SELECT f.*, f.created_at::text AS created_at_exact, u.username AS owner_username,
         EXISTS (SELECT 1 FROM likes l WHERE l.file_id = f.id AND l.user_id = '$VIEWER') AS liked_by_me
  FROM files f
  JOIN users u ON u.id = f.owner_id
  JOIN follows fo ON fo.followee_id = f.owner_id AND fo.follower_id = '$VIEWER'
  WHERE f.visibility = 'public' AND f.status = 'ready'
  ORDER BY f.created_at DESC, f.id DESC
  LIMIT 20"

cleanup() {
  "${PSQL[@]}" -c "DELETE FROM follows WHERE follower_id = '$VIEWER';
    DELETE FROM files WHERE owner_id LIKE 'feed-%';
    DELETE FROM users WHERE id LIKE 'feed-%';" >/dev/null
}
trap cleanup EXIT

echo "seeding $AUTHORS authors x $PUBLISHED_PER_AUTHOR published files + $PRIVATE_FILES private files..."
"${PSQL[@]}" -c "
  INSERT INTO users (id, username) VALUES ('$VIEWER', '$VIEWER');
  INSERT INTO users (id, username) SELECT 'feed-' || i, 'feed-' || i FROM generate_series(1, $AUTHORS) i;
  INSERT INTO files (id, owner_id, filename, content_type, size_bytes, status, visibility, object_key, created_at)
    SELECT gen_random_uuid(), 'feed-' || a, 'f.png', 'image/png', 1, 'ready', 'public', 'x',
           now() - random() * interval '30 days'
    FROM generate_series(1, $AUTHORS) a, generate_series(1, $PUBLISHED_PER_AUTHOR);
  INSERT INTO files (id, owner_id, filename, content_type, size_bytes, status, visibility, object_key, created_at)
    SELECT gen_random_uuid(), 'feed-' || (1 + i % $AUTHORS), 'p.png', 'image/png', 1, 'ready', 'private', 'x',
           now() - random() * interval '30 days'
    FROM generate_series(1, $PRIVATE_FILES) i;
  ANALYZE users; ANALYZE files; ANALYZE follows;" >/dev/null

explain_feed_following() {
  local follows=$1
  "${PSQL[@]}" -c "DELETE FROM follows WHERE follower_id = '$VIEWER';
    INSERT INTO follows (follower_id, followee_id) SELECT '$VIEWER', 'feed-' || i FROM generate_series(1, $follows) i;
    ANALYZE follows;" >/dev/null
  echo
  echo "=== viewer follows $follows users ==="
  "${PSQL[@]}" -c "EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON) $FEED_QUERY"
}

explain_feed_following 3
explain_feed_following "$AUTHORS"
