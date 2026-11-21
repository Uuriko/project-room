# SPDX-License-Identifier: Apache-2.0
"""Opt-in, read-only native checks: never create/unlock/change Keychain items."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid
import keychain

@unittest.skipUnless(sys.platform=='darwin' and os.environ.get('ROOM_BACKCHANNEL_NATIVE_KEYCHAIN_TEST')=='1', 'Opt-in macOS existing-login-item read only')
class NativeKeychainTests(unittest.TestCase):
    def test_existing_login_item_can_be_read_without_printing_or_creating(self):
        value=keychain.load()
        self.assertTrue(bool(value))
        del value

    def test_missing_item_fails_closed_without_creating_it(self):
        service='com.projectroom.absent-read-test-'+uuid.uuid4().hex
        with patch.object(keychain,'SERVICE',service):
            with self.assertRaisesRegex(RuntimeError,'Dedicated Keychain item unavailable'):
                keychain.load()

    def test_missing_login_keychain_fails_without_fallback(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(keychain.Path,'home',return_value=Path(directory)):
            # SecKeychainOpen can defer a nonexistent-file error until item lookup.
            with self.assertRaisesRegex(RuntimeError,'(Login Keychain|Dedicated Keychain item) unavailable'):
                keychain.load()

if __name__=='__main__':unittest.main()
