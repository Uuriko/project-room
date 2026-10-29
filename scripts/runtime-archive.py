#!/usr/bin/env python3
"""Archive a verified runtime without host metadata. Never overwrites output."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile

MANIFEST = 'runtime-manifest.json'


def collect(root, expected_commit=None):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('runtime must be a real directory')
    actual = set()
    actual_dirs = set()
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink() or name.startswith('._') or name == '__MACOSX':
                raise ValueError('symlink or OS metadata in runtime')
            if name in dirs:
                actual_dirs.add(path.relative_to(root).as_posix())
            if name in files:
                if not path.is_file():
                    raise ValueError('non-regular runtime file')
                actual.add(path.relative_to(root).as_posix())
    raw = (root / MANIFEST).read_bytes()
    manifest = json.loads(raw)
    if manifest.get('format') != 1 or any(not re.fullmatch('[0-9a-f]{40}', str(manifest.get(k, ''))) for k in ('sourceCommit', 'sourceTree')):
        raise ValueError('invalid runtime manifest identity')
    if expected_commit and manifest['sourceCommit'] != expected_commit:
        raise ValueError('source commit mismatch')
    entries = manifest['files']
    names = [entry['path'] for entry in entries]
    if names != sorted(set(names)) or MANIFEST in names:
        raise ValueError('manifest paths must be unique and sorted')
    for name in names:
        if not name or PurePosixPath(name).is_absolute() or any(part in ('', '.', '..') for part in name.split('/')) or '\\' in name:
            raise ValueError('unsafe manifest path')
    expected_dirs = {str(parent) for name in names for parent in PurePosixPath(name).parents if str(parent) != '.'}
    if actual_dirs != expected_dirs:
        raise ValueError('runtime directories differ from manifest')
    if actual != set(names) | {MANIFEST}:
        raise ValueError('runtime files differ from manifest')
    contents = {}
    for entry in entries:
        path = root / entry['path']
        data = path.read_bytes()
        if type(entry['bytes']) is not int or len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('runtime bytes differ from manifest')
        contents[entry['path']] = (data, 0o755 if path.stat().st_mode & 0o111 else 0o644)
    contents[MANIFEST] = (raw, 0o644)
    return manifest, contents


def create_archive(root, output, expected_commit=None, manifest_digest=None):
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise FileExistsError('output already exists')
    if Path(root).resolve() in output.resolve().parents:
        raise ValueError('output must be outside runtime')
    manifest, contents = collect(root, expected_commit)
    if manifest_digest and hashlib.sha256(contents[MANIFEST][0]).hexdigest() != manifest_digest:
        raise ValueError('manifest changed after verification')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, prefix='.runtime-archive-', delete=False) as target:
            temporary = target.name
            with gzip.GzipFile(filename='', mode='wb', fileobj=target, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                    for name, (data, mode) in sorted(contents.items()):
                        info = tarfile.TarInfo(name)
                        info.size = len(data)
                        info.mode = mode
                        info.mtime = info.uid = info.gid = 0
                        info.uname = info.gname = ''
                        archive.addfile(info, io.BytesIO(data))
            target.flush()
            os.fsync(target.fileno())
        # Atomic creation, unlike rename this never overwrites a racing writer.
        os.link(temporary, output)
    finally:
        if temporary:
            os.unlink(temporary)
    return {'archive': str(output), 'sourceCommit': manifest['sourceCommit'], 'files': len(contents),
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('runtime')
    parser.add_argument('output')
    parser.add_argument('--expected-commit', required=True)
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    verifier = Path(__file__).with_name('runtime-package.mjs')
    result = subprocess.run([args.node, str(verifier), 'verify', args.runtime, args.expected_commit], check=True, capture_output=True, text=True)
    verified = json.loads(result.stdout)
    if verified.get('verified') is not True:
        raise ValueError('runtime verifier did not confirm package')
    print(json.dumps(create_archive(args.runtime, args.output, args.expected_commit, verified['manifestSha256'])))


if __name__ == '__main__':
    main()
