import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runtime_archive', Path(__file__).parents[1] / 'scripts/runtime-archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'runtime'
        (self.root / 'bin').mkdir(parents=True)
        (self.root / 'bin/start').write_bytes(b'#!/bin/sh\nexit 0\n')
        (self.root / 'bin/start').chmod(0o700)
        (self.root / 'data').write_bytes('Café'.encode())
        entries = [{'path': str(p.relative_to(self.root)), 'bytes': len(p.read_bytes()), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(self.root.rglob('*')) if p.is_file()]
        (self.root / module.MANIFEST).write_text(json.dumps({'format': 1, 'sourceCommit': 'a' * 40, 'sourceTree': 'b' * 40, 'files': entries}))

    def test_deterministic_contents_and_metadata(self):
        first, second = self.base / 'first.tgz', self.base / 'second.tgz'
        module.create_archive(self.root, first, 'a' * 40)
        for path in self.root.rglob('*'):
            os.utime(path, (123456789, 123456789))
        if hasattr(os, 'setxattr'):
            try:
                os.setxattr(self.root / 'data', 'user.archive-test', b'not portable')
            except OSError:
                pass
        module.create_archive(self.root, second, 'a' * 40)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with tarfile.open(first) as archive:
            self.assertEqual(archive.getnames(), sorted(['bin/start', 'data', module.MANIFEST]))
            for member in archive:
                self.assertEqual(archive.extractfile(member).read(), (self.root / member.name).read_bytes())
                self.assertEqual((member.uid, member.gid, member.mtime, member.uname, member.gname), (0, 0, 0, '', ''))
                self.assertEqual(member.pax_headers, {})
                self.assertEqual(member.mode, 0o755 if member.name == 'bin/start' else 0o644)
        with self.assertRaises(FileExistsError):
            module.create_archive(self.root, first)

    def test_refuses_extras_symlinks_and_changed_bytes(self):
        for kind in ('extra', '._data', 'link'):
            path = self.root / kind
            if kind == 'link':
                path.symlink_to(self.root / 'data')
            else:
                path.write_text('extra')
            with self.assertRaises(ValueError):
                module.create_archive(self.root, self.base / 'bad.tgz')
            self.assertFalse((self.base / 'bad.tgz').exists())
            path.unlink()
        (self.root / 'extra-directory').mkdir()
        with self.assertRaises(ValueError):
            module.create_archive(self.root, self.base / 'bad.tgz')
        (self.root / 'extra-directory').rmdir()
        (self.root / 'data').write_text('changed')
        with self.assertRaises(ValueError):
            module.create_archive(self.root, self.base / 'bad.tgz')

    def test_failure_cleans_partial_and_identity_is_checked(self):
        with self.assertRaises(ValueError):
            module.create_archive(self.root, self.base / 'bad.tgz', 'c' * 40)
        with patch.object(module.tarfile.TarFile, 'addfile', side_effect=OSError('disk fixture')):
            with self.assertRaises(OSError):
                module.create_archive(self.root, self.base / 'bad.tgz')
        self.assertFalse((self.base / 'bad.tgz').exists())
        self.assertEqual(list(self.base.glob('.runtime-archive-*')), [])


if __name__ == '__main__':
    unittest.main()
