#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import sys
import time
import uuid
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

HERE = Path(__file__).parent


def step(n, title):
    print(f"\n=== step {n}: {title} ===")


def show(resp, keys=None):
    try:
        body = resp.json()
        if keys:
            body = {k: body.get(k) for k in keys}
        print(f"    HTTP {resp.status_code}: {json.dumps(body, indent=2)[:600]}")
    except Exception:
        print(f"    HTTP {resp.status_code}")


def get_token(base, username, password):
    resp = requests.post(
        f"{base}/realms/media/protocol/openid-connect/token",
        data={
            "grant_type": "password",
            "client_id": "media-cli",
            "username": username,
            "password": password,
        },
        verify=False,
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def decode_jwt_payload(token):
    part = token.split(".")[1]
    part += "=" * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part))


def api(token, base, method, path, **kw):
    headers = kw.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.request(method, f"{base}{path}", headers=headers, verify=False, timeout=30, **kw)


def api_retry(token, base, method, path, max_retries=5, **kw):
    resp = api(token, base, method, path, **kw)
    for _ in range(max_retries):
        if resp.status_code != 429:
            return resp
        wait = min(int(resp.headers.get("Retry-After", "5") or 5), 12)
        print(f"    got 429 rate-limited; client honors Retry-After and waits {wait}s (backoff is the client's job)")
        time.sleep(wait)
        resp = api(token, base, method, path, **kw)
    return resp


def wait_for_final_status(token, base, file_id, timeout=90):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        resp = api(token, base, "GET", f"/v1/files/{file_id}")
        resp.raise_for_status()
        status = resp.json()["file"]["status"]
        if status != last:
            print(f"    status transition: {last or '(created)'} -> {status}")
            last = status
        if status in ("ready", "infected", "failed"):
            return status, resp.json()["file"]
        time.sleep(1)
    raise TimeoutError(f"file {file_id} did not reach a final state within {timeout}s")


def main():
    parser = argparse.ArgumentParser(description="mediashare end-to-end demo")
    parser.add_argument("--auth-base", default="https://auth.localhost")
    parser.add_argument("--api-base", default="https://api.localhost")
    parser.add_argument("--file", default=str(HERE / "samples" / "sample.png"))
    parser.add_argument("--infected-file", default=str(HERE / "samples" / "infected.txt"))
    parser.add_argument("--username", default="demo")
    parser.add_argument("--password", default="demo-pass")
    parser.add_argument("--admin-username", default="admin")
    parser.add_argument("--admin-password", default="admin-pass")
    parser.add_argument("--skip-upload", action="store_true")
    parser.add_argument("--skip-infected", action="store_true")
    parser.add_argument("--skip-rate-limit", action="store_true")
    parser.add_argument("--skip-admin", action="store_true")
    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        sys.exit(f"sample file not found: {file_path} (run python3 demo/make_samples.py)")

    content_type = "image/png" if file_path.suffix == ".png" else "text/plain"
    local_bytes = file_path.read_bytes()
    local_sha = hashlib.sha256(local_bytes).hexdigest()

    print("mediashare distributed-system demo")
    print(f"file: {file_path} ({len(local_bytes)} bytes, {content_type})")

    step(1, "call the API without a token (expect 401)")
    resp = api(None, args.api_base, "GET", "/v1/files")
    show(resp)
    assert resp.status_code == 401, "expected 401 without token"

    step(2, "get an OIDC access token from Keycloak (password grant)")
    token = get_token(args.auth_base, args.username, args.password)
    claims = decode_jwt_payload(token)
    print(f"    JWT claims: iss={claims['iss']}")
    print(f"    sub={claims['sub']}")
    print(f"    roles={claims.get('realm_access', {}).get('roles')}")
    print(f"    exp in {claims['exp'] - int(time.time())}s")

    step(3, "register file metadata, receive a presigned S3 upload URL")
    idem = str(uuid.uuid4())
    resp = api(token, args.api_base, "POST", "/v1/files", headers={"Idempotency-Key": idem}, json={
        "filename": file_path.name,
        "contentType": content_type,
        "sizeBytes": len(local_bytes),
    })
    show(resp)
    resp.raise_for_status()
    created = resp.json()
    file_id = created["file"]["id"]
    upload_url = created["uploadUrl"]
    print(f"    upload URL host: {requests.utils.urlparse(upload_url).netloc} (note: signed, no auth header needed)")

    step(4, "replay the same Idempotency-Key (expect 200 with idempotentReplay)")
    resp = api(token, args.api_base, "POST", "/v1/files", headers={"Idempotency-Key": idem}, json={
        "filename": file_path.name,
        "contentType": content_type,
        "sizeBytes": len(local_bytes),
    })
    show(resp, ["idempotentReplay", "file"])
    assert resp.status_code == 200 and resp.json().get("idempotentReplay")

    if not args.skip_upload:
        step(5, "upload the bytes DIRECTLY to S3 via the presigned URL (bypasses the API)")
        put = requests.put(upload_url, data=local_bytes, headers={"Content-Type": content_type}, verify=False, timeout=60)
        print(f"    HTTP {put.status_code} from S3 (200 = stored)")
        put.raise_for_status()

        step(6, "tell the API the upload finished -> triggers outbox event -> Kafka -> processor")
        resp = api_retry(token, args.api_base, "POST", f"/v1/files/{file_id}/complete")
        show(resp)
        resp.raise_for_status()
        assert resp.status_code == 202

    step(7, "poll file status until the async pipeline finishes (eventual consistency)")
    status, file_obj = wait_for_final_status(token, args.api_base, file_id)
    print(f"    final status: {status}")

    if status == "ready":
        step(8, "verify checksum of processed file matches the local file")
        print(f"    local  sha256: {local_sha}")
        print(f"    remote sha256: {file_obj['checksum']}")
        assert file_obj["checksum"] == local_sha, "checksum mismatch!"
        print("    checksums match: file integrity verified end-to-end")

        step(9, "get a short-lived presigned download URL for the ORIGINAL (private bucket)")
        resp = api_retry(token, args.api_base, "POST", f"/v1/files/{file_id}/download-url")
        show(resp, ["expiresIn"])
        dl = requests.get(resp.json()["url"], verify=False, timeout=30)
        print(f"    HTTP {dl.status_code}, {len(dl.content)} bytes downloaded without any auth header")
        assert hashlib.sha256(dl.content).hexdigest() == local_sha
        print("    downloaded bytes are identical to the original upload")

        if file_obj["thumbnailUrl"]:
            out_dir = HERE / "out"
            out_dir.mkdir(exist_ok=True)
            thumb = requests.get(file_obj["thumbnailUrl"], verify=False, timeout=30)
            thumb_path = out_dir / f"{file_id}.webp"
            thumb_path.write_bytes(thumb.content)
            print(f"    thumbnail (public bucket, no auth needed): {thumb_path} ({len(thumb.content)} bytes)")

    if not args.skip_infected:
        step(10, "upload an 'infected' file (processor must reject + purge it)")
        inf_path = Path(args.infected_file)
        if inf_path.exists():
            inf_bytes = inf_path.read_bytes()
            resp = api_retry(token, args.api_base, "POST", "/v1/files", json={
                "filename": inf_path.name,
                "contentType": "text/plain",
                "sizeBytes": len(inf_bytes),
            })
            resp.raise_for_status()
            inf = resp.json()
            put = requests.put(inf["uploadUrl"], data=inf_bytes, headers={"Content-Type": "text/plain"}, verify=False, timeout=30)
            put.raise_for_status()
            resp = api_retry(token, args.api_base, "POST", f"/v1/files/{inf['file']['id']}/complete")
            resp.raise_for_status()
            inf_status, _ = wait_for_final_status(token, args.api_base, inf["file"]["id"])
            print(f"    infected-file final status: {inf_status} (expected infected)")
            resp = api(token, args.api_base, "POST", f"/v1/files/{inf['file']['id']}/download-url")
            print(f"    download attempt for infected file: HTTP {resp.status_code} (expected 403 blocked)")
            assert inf_status == "infected" and resp.status_code == 403

    if not args.skip_rate_limit:
        step(11, "burst 12 mutating requests to trip the per-user Redis token bucket (expect 429s)")
        codes = []
        for _ in range(12):
            r = api(token, args.api_base, "POST", "/v1/files", json={
                "filename": "burst.png", "contentType": "image/png", "sizeBytes": 1024,
            })
            codes.append(r.status_code)
        ok = codes.count(201)
        limited = codes.count(429)
        print(f"    results: {ok} accepted, {limited} rate-limited -> {codes}")
        assert limited > 0, "expected at least one 429"

    if not args.skip_admin:
        step(12, "RBAC: regular user cannot delete (403), admin can (204)")
        resp = api_retry(token, args.api_base, "DELETE", f"/v1/files/{file_id}")
        print(f"    demo user DELETE: HTTP {resp.status_code} (expected 403)")
        assert resp.status_code == 403
        admin_token = get_token(args.auth_base, args.admin_username, args.admin_password)
        admin_claims = decode_jwt_payload(admin_token)
        print(f"    admin roles: {admin_claims.get('realm_access', {}).get('roles')}")
        resp = api_retry(admin_token, args.api_base, "DELETE", f"/v1/files/{file_id}")
        print(f"    admin DELETE: HTTP {resp.status_code} (expected 204)")
        assert resp.status_code == 204
        resp = api(admin_token, args.api_base, "GET", f"/v1/files/{file_id}")
        print(f"    GET after delete: HTTP {resp.status_code} (expected 404)")

    step(13, "list remaining files")
    resp = api(token, args.api_base, "GET", "/v1/files?limit=10")
    files = resp.json()["files"]
    print(f"    {len(files)} file(s): " + ", ".join(f"{f['filename']}={f['status']}" for f in files))

    print("\nDemo finished successfully.")
    print("Watch the pipeline live:  make logs")
    print("Inspect messages:         docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic file-events --from-beginning")
    print("Dead-letter queue:        ... --topic file-events-dlq")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        sys.exit(f"DEMO ASSERTION FAILED: {e}")
    except requests.HTTPError as e:
        sys.exit(f"HTTP error: {e} body={getattr(e.response, 'text', '')[:300]}")
