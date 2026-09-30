#!/usr/bin/env python3
"""Upload either existing Room Worker via the Cloudflare API.
Uses the custom.cloudflare surrogate only when making a request. Metadata
reads the selected checked-in Worker topology and preserves live text/secret
bindings. No migrations, schedules, routes or custom domains are changed.

Usage: deploy-live.py <script_name> <account_id> <public_dir> <bundle_path>
"""
import sys, os, json, hashlib, base64, mimetypes, uuid
import urllib.request, urllib.error

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")

ALLOWED_HOSTS = ("api.cloudflare.com",)
BASE = "https://api.cloudflare.com"

# 2026-09-27 (deep audit 5850308933): the script name selects which Worker
# receives the production bindings. Accept only the known project-room
# script names; an arbitrary name would deploy the bundle (with production
# bindings) to the wrong Worker.
ALLOWED_SCRIPT_NAMES = ("project-room", "project-room-staging")

def api(method, path, body=None, content_type="application/json"):
    data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
    headers = {}
    if data:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    from dynamic_credentials import add_surrogate_to_request
    add_surrogate_to_request(req, "custom.cloudflare", entry_name="access_token", allowed_hosts=ALLOWED_HOSTS)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
        print(f"HTTP {e.code} on {method} {path}")
        print(raw[:1500].decode("utf-8", "replace"))
        sys.exit(1)
    return json.loads(raw.decode("utf-8"))

def deployment_metadata(script_name):
    """Select the existing Worker; never turn the entry into a namespace owner.

    The checked-in JSONC currently uses strict JSON. Parse failures fail closed
    before any upload instead of falling back to guessed deployment settings.
    """
    config_path = os.path.join(os.path.dirname(__file__), "..", "cloudflare", "wrangler.jsonc")
    with open(config_path, encoding="utf8") as config_file:
        config = json.load(config_file)
    if script_name == config["name"]:
        selected = config
    else:
        matches = [value for value in config.get("env", {}).values() if value.get("name") == script_name]
        if len(matches) != 1:
            raise ValueError("Worker is not uniquely configured in wrangler.jsonc")
        selected = {**config, **matches[0]}
    bindings = [{"type": "durable_object_namespace", **binding}
                for binding in selected["durable_objects"]["bindings"]]
    bindings.append({"type": "assets", "name": selected["assets"]["binding"]})
    bindings.extend({"type": "plain_text", "name": name, "text": value}
                    for name, value in selected.get("vars", {}).items())
    return {
        "main_module": "room.js",
        "compatibility_date": selected["compatibility_date"],
        "compatibility_flags": selected.get("compatibility_flags", []),
        "bindings": bindings,
        "keep_bindings": ["secret_text", "plain_text"],
        "limits": selected["limits"],
        "observability": selected["observability"],
        "assets": {"config": {"run_worker_first": selected["assets"]["run_worker_first"]}},
    }


def build_manifest(public_dir):
    """Hash every regular file under public_dir into the asset manifest.

    Symlinks (and other non-regular files) are refused loudly: following a
    file symlink would upload the target's bytes as a public asset, so a
    stray or malicious link in the build output must fail the deploy rather
    than silently exfiltrate local file contents.
    """
    manifest, files = {}, {}
    for root, _, names in os.walk(public_dir):
        for n in names:
            full = os.path.join(root, n)
            if os.path.islink(full) or not os.path.isfile(full):
                print(f"refusing to upload non-regular asset: {full}", file=sys.stderr)
                sys.exit(1)
            rel = "/" + os.path.relpath(full, public_dir).replace(os.sep, "/")
            with open(full, "rb") as f:
                content = f.read()
            h = hashlib.sha256(content).hexdigest()[:32]
            manifest[rel] = {"hash": h, "size": len(content)}
            files[h] = (rel, content)
    return manifest, files


def main():
    if len(sys.argv) != 5:
        print("Usage: deploy-live.py <script_name> <account_id> <public_dir> <bundle_path>",
              file=sys.stderr)
        sys.exit(2)
    script_name, account_id, public_dir, bundle_path = sys.argv[1:5]
    if script_name not in ALLOWED_SCRIPT_NAMES:
        print(f"refusing: unknown script name {script_name!r} "
              f"(allowed: {', '.join(ALLOWED_SCRIPT_NAMES)})", file=sys.stderr)
        sys.exit(2)
    SCRIPT = script_name
    metadata = deployment_metadata(SCRIPT)

    # 1. Manifest
    manifest, files = build_manifest(public_dir)
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

    # 4. Upload using the topology selected before any network operation.
    with open(bundle_path, "rb") as f:
        script = f.read()
    metadata["assets"]["jwt"] = completion_jwt
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
