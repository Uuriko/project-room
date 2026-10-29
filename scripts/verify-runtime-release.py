"""Verify a GitHub runtime asset against an independently built exact-source package.

Never extracts or executes archive contents, changes a release, or uploads assets.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
from urllib.parse import quote

ASSET = "project-room-runtime.tar.gz"
MAX_ARCHIVE = 128 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_archive(archive, expected):
    expected = Path(expected)
    files = {}
    for path in expected.rglob("*"):
        require(not path.is_symlink(), "expected package contains a symlink")
        if path.is_file():
            files[path.relative_to(expected).as_posix()] = path
    require(bool(files), "expected package is empty")
    require(Path(archive).stat().st_size <= MAX_ARCHIVE, "archive too large")
    seen = set()
    with tarfile.open(archive, "r:gz") as package:
        for index, member in enumerate(package):
            require(index < len(files) * 8 + 100, "too many archive entries")
            name = member.name
            while name.startswith("./"):
                name = name[2:]
            require(not name.startswith("/") and ".." not in name.split("/"), "unsafe archive path")
            if member.isdir():
                require(name in ("", ".") or any(p.startswith(name.rstrip("/") + "/") for p in files), "unexpected directory")
                continue
            require(member.isfile(), "archive links and special files are forbidden")
            require(name in files and name not in seen, "unexpected or duplicate file")
            wanted = files[name].read_bytes()
            require(member.size == len(wanted), "file size mismatch")
            with package.extractfile(member) as stream:
                require(stream.read(len(wanted) + 1) == wanted, "file content mismatch")
            seen.add(name)
    require(seen == set(files), "missing package files")
    return {"files": len(seen), "archiveSha256": hashlib.sha256(Path(archive).read_bytes()).hexdigest()}


def release_identity(release, commit, sha):
    require(commit.get("sha") == sha, "tag does not resolve to expected commit")
    require(release.get("draft") is False and release.get("prerelease") is False, "release is not a published stable release")
    assets = [a for a in release.get("assets", []) if a.get("name") == ASSET]
    require(len(assets) == 1, "exactly one runtime asset is required")
    asset = assets[0]
    require(asset.get("state") == "uploaded", "asset upload is incomplete")
    require(isinstance(asset.get("size"), int) and 0 < asset["size"] <= MAX_ARCHIVE, "invalid asset size")
    require(isinstance(asset.get("id"), int) and isinstance(release.get("id"), int), "missing release or asset id")
    return {"releaseId": release["id"], "assetId": asset["id"], "assetBytes": asset["size"], "updatedAt": asset.get("updated_at")}


def valid_runtime_tag(tag):
    return re.fullmatch(r"runtime-\d{4}-\d{2}-\d{2}-[a-f0-9]{7}(?:-r(?:[2-9]|[1-9][0-9]+))?", tag) is not None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("repository", "tag", "sha", "expected", "receipt"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository), "invalid repository")
    require(re.fullmatch(r"[a-f0-9]{40}", args.sha), "full source SHA required")
    require(valid_runtime_tag(args.tag), "invalid runtime tag")
    # A failed retry must not leave an earlier success available to artifact upload.
    receipt_path = Path(args.receipt)
    receipt_path.unlink(missing_ok=True)
    # The expected directory must itself satisfy the existing runtime contract.
    subprocess.run(["node", str(Path(__file__).with_name("runtime-package.mjs")), "verify", args.expected, args.sha], check=True, capture_output=True, timeout=60)
    root = "repos/" + args.repository
    def read(path):
        return json.loads(subprocess.check_output(["gh", "api", root + path], timeout=60))
    def snapshot():
        return release_identity(read("/releases/tags/" + quote(args.tag, safe="")), read("/commits/" + quote(args.tag, safe="")), args.sha)
    before = snapshot()
    with tempfile.TemporaryDirectory(prefix="runtime-release-verify-") as directory:
        subprocess.run(["gh", "release", "download", args.tag, "--repo", args.repository, "--pattern", ASSET, "--dir", directory], check=True, capture_output=True, timeout=120)
        archive = Path(directory) / ASSET
        require(archive.stat().st_size == before["assetBytes"], "download size differs from asset metadata")
        verified = verify_archive(archive, args.expected)
    require(snapshot() == before, "release changed during verification")
    receipt = {"kind": "room.runtime-publication-verification.v1", "checkedAt": datetime.now(timezone.utc).isoformat(), "repository": args.repository,
               "tag": args.tag, "sourceCommit": args.sha, **before, **verified, "verified": True,
               "publicationPromoted": False}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=receipt_path.parent, delete=False) as output:
            temporary = Path(output.name)
            output.write(json.dumps(receipt, indent=2) + "\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, receipt_path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
