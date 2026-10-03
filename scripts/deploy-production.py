#!/usr/bin/env python3
"""Deploy the project-room Worker to PRODUCTION via the Cloudflare API.

Ported for CI from the operator-run ~/workspace/room-deploy/deploy-live.py
(which authenticates through the Hatch connector surrogate). This copy is
identical in deploy logic — asset manifest, bucket upload, script metadata —
but authenticates with a plain CLOUDFLARE_API_TOKEN bearer token from the
environment, so it runs in GitHub Actions. Battle-tested details preserved:
production CPU budget 30000ms (PR #1065; 1000ms caused 1101/500s on
2026-09-25) and run_worker_first under assets.config (top-level is silently
ignored; first attempt 2026-09-25 kept 405ing).

Metadata mirrors cloudflare/wrangler.jsonc at the deployed commit, with
ROOM_ORIGIN kept at the live access origin (room.trydemigod.com).
Deliberately preserves live behavior otherwise: no migration (DO exists),
no schedule changes (live has none), routes/custom domains untouched.

WARNING: This deploys to PRODUCTION (ROOM_DEPLOYMENT=production). There is
no staging environment.

Usage: deploy-production.py <script_name> <account_id> <public_dir> <bundle_path>
Env:   CLOUDFLARE_API_TOKEN (required) — API token with Workers Scripts
       write and Workers Assets write on the account.
"""
import sys
import os
import json
import hashlib
import base64
import mimetypes
import uuid
import urllib.request
import urllib.error

ALLOWED_HOSTS = ("api.cloudflare.com",)
BASE = "https://api.cloudflare.com"


def api(method, path, body=None, content_type="application/json"):
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        print("CLOUDFLARE_API_TOKEN is not set; refusing to deploy.", flush=True)
        sys.exit(1)
    data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
    headers = {"Authorization": f"Bearer {token}"}
    if data:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    if urllib.parse.urlparse(BASE + path).hostname not in ALLOWED_HOSTS:
        print("refusing to talk to non-Cloudflare host", flush=True)
        sys.exit(1)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
        print(f"HTTP {e.code} on {method} {path}")
        print(raw[:1500].decode("utf-8", "replace"))
        sys.exit(1)
    return json.loads(raw.decode("utf-8"))


def main():
    script_name, account_id, public_dir, bundle_path = sys.argv[1:5]
    SCRIPT = script_name

    # 1. Manifest
    manifest, files = {}, {}
    for root, _, names in os.walk(public_dir):
        for n in names:
            full = os.path.join(root, n)
            rel = "/" + os.path.relpath(full, public_dir).replace(os.sep, "/")
            with open(full, "rb") as f:
                content = f.read()
            h = hashlib.sha256(content).hexdigest()[:32]
            manifest[rel] = {"hash": h, "size": len(content)}
            files[h] = (rel, content)
    print(f"manifest: {len(manifest)} files", flush=True)

    # 2. Asset upload session
    r = api("POST", f"/client/v4/accounts/{account_id}/workers/scripts/{SCRIPT}/assets-upload-session",
            {"manifest": manifest})
    jwt = r["result"]["jwt"]
    buckets = r["result"].get("buckets", [])
    print(f"upload session: {len(buckets)} buckets", flush=True)

    # 3. Upload buckets
    completion_jwt = jwt
    for bucket in buckets:
        boundary = f"----assetbucket{uuid.uuid4().hex[:8]}"
        parts = []
        for h in bucket:
            rel, content = files[h]
            ctype = mimetypes.guess_type(rel)[0] or "application/octet-stream"
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{h}"\r\nContent-Type: {ctype}\r\n\r\n'.encode()
                         + base64.b64encode(content) + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)
        req = urllib.request.Request(
            BASE + f"/client/v4/accounts/{account_id}/workers/assets/upload?base64=true",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                     "Authorization": f"Bearer {jwt}"},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                uresp = json.loads(resp.read().decode("utf-8"))
                if uresp.get("result", {}).get("jwt"):
                    completion_jwt = uresp["result"]["jwt"]
        except urllib.error.HTTPError as e:
            print(f"asset bucket upload failed: HTTP {e.code}")
            print(e.read()[:1000].decode("utf-8", "replace"))
            sys.exit(1)
    print("assets uploaded", flush=True)

    # 4. Script upload — metadata mirrors cloudflare/wrangler.jsonc
    with open(bundle_path, "rb") as f:
        script = f.read()
    metadata = {
        "main_module": "room.js",
        "compatibility_date": "2026-07-30",
        "compatibility_flags": ["nodejs_compat", "enable_nodejs_http_server_modules", "enable_request_signal", "request_signal_passthrough"],
        "bindings": [
            {"type": "durable_object_namespace", "name": "ROOM", "class_name": "ProjectRoom"},
            {"type": "assets", "name": "ASSETS"},
            {"type": "plain_text", "name": "ROOM_ORIGIN", "text": "https://room.trydemigod.com"},
            {"type": "plain_text", "name": "ROOM_DEPLOYMENT", "text": "production"},
            {"type": "plain_text", "name": "ROOM_GMAIL_ENABLED", "text": "0"},
            {"type": "plain_text", "name": "ROOM_GMAIL_PILOT_ONLY", "text": "1"},
            {"type": "plain_text", "name": "ROOM_SERVICE_MODE", "text": "cloudflare-production"},
        ],
        # Production CPU budget (mirrors env.production.limits.cpu_ms in
        # cloudflare/wrangler.jsonc, PR #1065): 30000ms. The production DO
        # shares this per-invocation budget; 1000ms caused CPU-limit resets
        # and whole-room 1101/500 failures on 2026-09-25. Never deploy 1000.
        "limits": {"cpu_ms": 30000},
        "observability": {"enabled": True, "head_sampling_rate": 1},
        # Mirror cloudflare/wrangler.jsonc assets config, including
        # run_worker_first: without it the edge asset worker claims extensionless
        # HTML paths (e.g. POST /join -> join.html) before the worker runs,
        # returning an empty 405 and serving the join page untemplated
        # (QA P1-3, 2026-09-25).
        # Wire shape per the Cloudflare Workers API (Assets { config, jwt },
        # Config { html_handling, not_found_handling, run_worker_first }):
        # the flag lives under config. A top-level run_worker_first in the
        # assets metadata is silently ignored (first deploy attempt 2026-09-25
        # kept 405ing); wrangler's internal routerConfig is not the wire shape.
        "assets": {
            "jwt": completion_jwt,
            "config": {"run_worker_first": True},
        },
    }
    boundary = "----deployboundary1234"
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n'.encode()
        + json.dumps(metadata).encode() + b"\r\n",
        f'--{boundary}\r\nContent-Disposition: form-data; name="room.js"; filename="room.js"\r\nContent-Type: application/javascript+module\r\n\r\n'.encode()
        + script + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    r = api("PUT", f"/client/v4/accounts/{account_id}/workers/scripts/{SCRIPT}",
            b"".join(parts), content_type=f"multipart/form-data; boundary={boundary}")
    if not r.get("success"):
        print("deploy failed:", json.dumps(r.get("errors"))[:1000])
        sys.exit(1)
    print("deployed OK", flush=True)


if __name__ == "__main__":
    main()
