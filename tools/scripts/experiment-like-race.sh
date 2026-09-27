#!/usr/bin/env bash
# Experiment: N concurrent likes on one file. Compares the api's statements (atomic
# `like_count + 1` under a row lock, apps/api/src/social/repository.ts `insertLike`) with a
# naive read-modify-write (read the count into the app, write back count + 1).
# Runs straight against Postgres with N parallel psql sessions (we only have 3 real users).
# Usage: tools/scripts/experiment-like-race.sh [N]   (stack must be up; cleans up after itself)
set -euo pipefail

LIKERS=${1:-50}
# The naive version's gap between read and write. In the api it would be one network
# round trip to Postgres (~1 ms); 50 ms just makes the race window easy to hit.
APP_THINK_TIME_S=0.05
OWNER=race-owner
PSQL=(docker compose exec -T postgres psql -U postgres -d mediashare -v ON_ERROR_STOP=1 -qtA)

new_published_file() {
  "${PSQL[@]}" -c "INSERT INTO files (id, owner_id, filename, content_type, size_bytes, status, visibility, object_key)
    VALUES (gen_random_uuid(), '$OWNER', 'race.png', 'image/png', 1, 'ready', 'public', 'race') RETURNING id"
}

# Same statements, in the same order, as likeFile().
like_atomic() {
  "${PSQL[@]}" -c "BEGIN;
    SELECT 1 FROM files f WHERE f.id = '$1' AND f.visibility = 'public' AND f.status = 'ready' FOR UPDATE;
    INSERT INTO likes (user_id, file_id) VALUES ('$2', '$1') ON CONFLICT DO NOTHING;
    UPDATE files SET like_count = like_count + 1 WHERE id = '$1';
    COMMIT;" >/dev/null
}

# What a Node handler would do with `SELECT like_count` then `UPDATE ... SET like_count = $n`.
like_naive() {
  "${PSQL[@]}" -c "DO \$\$
    DECLARE count_read_by_app int;
    BEGIN
      SELECT like_count INTO count_read_by_app FROM files WHERE id = '$1';
      PERFORM pg_sleep($APP_THINK_TIME_S);
      INSERT INTO likes (user_id, file_id) VALUES ('$2', '$1') ON CONFLICT DO NOTHING;
      UPDATE files SET like_count = count_read_by_app + 1 WHERE id = '$1';
    END \$\$;" >/dev/null
}

run_race() {
  local like_fn=$1 file_id
  file_id=$(new_published_file)
  for i in $(seq 1 "$LIKERS"); do "$like_fn" "$file_id" "race-$i" & done
  wait
  "${PSQL[@]}" -c "SELECT format('%-12s like_count=%s  rows in likes=%s', '$like_fn', like_count,
    (SELECT count(*) FROM likes WHERE file_id = f.id)) FROM files f WHERE id = '$file_id'"
}

cleanup() {
  "${PSQL[@]}" -c "DELETE FROM files WHERE owner_id = '$OWNER';
    DELETE FROM users WHERE id = '$OWNER' OR id LIKE 'race-%';" >/dev/null
}
trap cleanup EXIT

"${PSQL[@]}" -c "INSERT INTO users (id, username) SELECT 'race-' || i, 'race-' || i FROM generate_series(1, $LIKERS) i;
  INSERT INTO users (id, username) VALUES ('$OWNER', '$OWNER');" >/dev/null

echo "$LIKERS different users like one file at the same moment:"
run_race like_atomic
run_race like_naive
