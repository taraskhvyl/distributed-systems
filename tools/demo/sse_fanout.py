#!/usr/bin/env python3
"""Phase 3 experiment: does every open tab of a user get every live event, with N notifiers?

The file owner opens TABS SSE streams (Envoy spreads them over the notifier replicas),
then LIKERS other users each like one of the owner's published files, so each like emits
one `file.liked` event. Prints how many events each tab received.

Uses the k6 loadtest users (created by `make loadtest`), never the seeded demo users,
so `make demo`'s assertions are unaffected.

    .venv/bin/python tools/demo/sse_fanout.py
"""
import time

from client import api, api_retry, get_token, open_event_stream

AUTH = "https://auth.localhost"
API = "https://api.localhost"
LOADTEST_PASSWORD = "loadtest-pass"  # the k6 script's test users (tools/loadtest/baseline.js)
OWNER = "loadtest-01"  # k6 setup() publishes its file
LIKERS = [f"loadtest-{i:02d}" for i in range(2, 22)]
TABS = 3
DELIVERY_GRACE_S = 5  # outbox relay tick + Kafka + notifier, with room to spare
PAUSE_BETWEEN_LIKERS_S = 0.25  # 3 requests per liker; stays under the edge's 20 req/s per IP


def find_published_file(owner_token):
    files = api(owner_token, API, "GET", "/v1/files").json()["files"]
    return next(f["id"] for f in files if f["visibility"] == "public" and f["status"] == "ready")


def main():
    owner_token = get_token(AUTH, OWNER, LOADTEST_PASSWORD)
    file_id = find_published_file(owner_token)
    tabs = [open_event_stream(owner_token, API) for _ in range(TABS)]

    for liker in LIKERS:
        token = get_token(AUTH, liker, LOADTEST_PASSWORD)
        # Only a NEW like emits `file.liked`, so clear any like left over from k6 first.
        api_retry(token, API, "DELETE", f"/v1/files/{file_id}/like")
        api_retry(token, API, "PUT", f"/v1/files/{file_id}/like")
        time.sleep(PAUSE_BETWEEN_LIKERS_S)
    time.sleep(DELIVERY_GRACE_S)

    print(f"{len(LIKERS)} likes on {file_id}")
    for n, events in enumerate(tabs, start=1):
        likes = [e for e in events if e.get("eventType") == "file.liked" and e.get("fileId") == file_id]
        print(f"  tab {n}: {len(likes)} / {len(LIKERS)}")


if __name__ == "__main__":
    main()
