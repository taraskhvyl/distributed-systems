#!/usr/bin/env bash
# Experiment: how the fan-out-on-read feed behaves under load as users follow more people.
# Seeds AUTHORS authors with published files directly in Postgres, makes every loadtest user
# follow N of them, and runs k6 with feed reads only. One k6 run per N.
# Needs the stack up and the loadtest users to exist: run `make loadtest` once first.
# Usage: tools/scripts/experiment-feed-scale.sh   (cleans up after itself)
set -euo pipefail

AUTHORS=2000
PUBLISHED_PER_AUTHOR=20
FOLLOW_LEVELS=(100 1000 2000) # each loadtest user follows this many authors
VUS=50
SAMPLE_AT_S=60 # steady state of baseline.js (30 s ramp, then 60 s plateau)
PSQL=(docker compose exec -T postgres psql -U postgres -d mediashare -v ON_ERROR_STOP=1 -qtA)

cleanup() {
  "${PSQL[@]}" -c "DELETE FROM follows WHERE followee_id LIKE 'feed-%';
    DELETE FROM files WHERE owner_id LIKE 'feed-%';
    DELETE FROM users WHERE id LIKE 'feed-%';" >/dev/null
}
trap cleanup EXIT

echo "seeding $AUTHORS authors x $PUBLISHED_PER_AUTHOR published files..."
"${PSQL[@]}" -c "
  INSERT INTO users (id, username) SELECT 'feed-' || i, 'feed-' || i FROM generate_series(1, $AUTHORS) i;
  INSERT INTO files (id, owner_id, filename, content_type, size_bytes, status, visibility, object_key, created_at)
    SELECT gen_random_uuid(), 'feed-' || a, 'f.png', 'image/png', 1, 'ready', 'public', 'x',
           now() - random() * interval '30 days'
    FROM generate_series(1, $AUTHORS) a, generate_series(1, $PUBLISHED_PER_AUTHOR);
  ANALYZE users; ANALYZE files;" >/dev/null

# Each viewer starts at a different author, so the 50 feeds are not the same query.
follow_authors() {
  local follows=$1
  "${PSQL[@]}" -c "
    DELETE FROM follows WHERE followee_id LIKE 'feed-%';
    INSERT INTO follows (follower_id, followee_id)
      SELECT v.id, 'feed-' || (1 + (v.n + i) % $AUTHORS)
      FROM (SELECT id, row_number() OVER (ORDER BY username) AS n FROM users WHERE username LIKE 'loadtest-%') v,
           generate_series(1, $follows) i;
    ANALYZE follows;" >/dev/null
}

busy_cpu_sample() {
  sleep "$SAMPLE_AT_S"
  docker stats --no-stream --format '  cpu {{.Name}} {{.CPUPerc}}' mediashare-postgres-1 mediashare-api-1
  "${PSQL[@]}" -c "SELECT '  pg sessions: ' || state || ' ' || count(*) FROM pg_stat_activity
    WHERE datname = 'mediashare' GROUP BY state;"
}

for follows in "${FOLLOW_LEVELS[@]}"; do
  follow_authors "$follows"
  echo
  echo "=== each of 50 users follows $follows authors, $VUS VUs, feed only ==="
  busy_cpu_sample &
  k6_output=/tmp/feed-scale-$follows.log # full k6 summary, kept for digging
  docker compose --profile loadtest run --rm -e FEED_SHARE=1 -e VUS=$VUS \
    -e K6_SUMMARY_TREND_STATS="med,p(95),p(99),max" k6 >"$k6_output" 2>&1 || true
  grep -E "^ +\{ name:feed \}\.+:|^ +(http_reqs|checks_failed)\.+:" "$k6_output" || true
  wait
done
