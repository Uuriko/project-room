# SPDX-License-Identifier: Apache-2.0
import http.client
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import install
import server

class DeadlineTests(unittest.TestCase):
    def test_expired_sqlite_writer_never_commits_after_lock_released(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = server.Ledger(Path(directory) / 'ledger.sqlite')
            db = sqlite3.connect(str(ledger.path))
            db.execute('BEGIN IMMEDIATE')
            started = time.monotonic()
            try:
                with self.assertRaises((TimeoutError, sqlite3.OperationalError)):
                    ledger.post('release', 'must not commit', requestId='deadline-write', _deadline=started + .08)
                self.assertLess(time.monotonic() - started, .8)
            finally:
                db.rollback(); db.close()
            self.assertEqual(ledger.read('release')['messages'], [])

    def test_batch_does_not_dispatch_post_after_first_call_expires(self):
        with tempfile.TemporaryDirectory() as directory:
            service = server.Service('127.0.0.1', 0, 'synthetic-deadline-bearer-00000000000000', Path(directory)/'ledger.sqlite', Path.cwd(), 'localhost')
            thread = threading.Thread(target=service.serve_forever, daemon=True); thread.start()
            def slow_status(_deadline=None):
                time.sleep(.2)
                return {}
            try:
                with patch.object(server, 'REQUEST_BUDGET_SECONDS', .08), patch.object(service, 'status', slow_status):
                    connection = http.client.HTTPConnection('127.0.0.1', service.server_address[1], timeout=2)
                    body = [{'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'status'}}, {'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'post','arguments':{'room':'release','text':'must not dispatch','requestId':'late-batch'}}}]
                    connection.request('POST','/mcp',json.dumps(body),{'Content-Type':'application/json','Authorization':'Bearer synthetic-deadline-bearer-00000000000000'})
                    with self.assertRaises((http.client.RemoteDisconnected, ConnectionResetError)):
                        connection.getresponse()
                    connection.close(); time.sleep(.25)
                self.assertEqual(service.ledger.read('release')['messages'], [])
            finally:
                service.shutdown(); service.server_close(); thread.join(2)

class RetargetTests(unittest.TestCase):
    def test_loaded_job_identity_requires_matching_path_program_and_arguments(self):
        expected = ['/usr/bin/python3','/private/service.py','--config','/private/config.json']
        plist = Path('/private/service.plist')
        good = '\tpath = /private/service.plist\n\tprogram = /usr/bin/python3\n\targuments = {\n' + ''.join('\t\t'+v+'\n' for v in expected) + '\t}\n'
        for output in [good,good.replace('/private/service.plist','/other.plist'),good.replace('/private/service.py','/other.py'),good.replace('\tprogram = /usr/bin/python3','\tprogram = /other')]:
            with patch.object(install.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout=output)):
                if output==good:self.assertTrue(install.verify_loaded_job(plist,expected).endswith(install.LABEL))
                else:
                    with self.assertRaises(ValueError):install.verify_loaded_job(plist,expected)

    def test_failed_activation_restores_exact_config_and_keeps_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);config=base/'config.json';previous=b'{"bind":"127.0.0.1"}\n';config.write_bytes(previous)
            ledger=base/'ledger.sqlite';ledger.write_bytes(b'preserve old data')
            with patch.object(install,'verify_loaded_job',return_value='gui/123/owned'), patch.object(install.subprocess,'run',side_effect=[subprocess.CalledProcessError(1,[]),subprocess.CompletedProcess([],0)]):
                with self.assertRaisesRegex(RuntimeError,'previous config restored; recovery requested'):
                    install.retarget_config(base,base/'job.plist',['python'],{'bind':'100.64.0.1'})
            self.assertEqual(config.read_bytes(),previous);self.assertEqual(ledger.read_bytes(),b'preserve old data')
            self.assertEqual(config.stat().st_mode & 0o777,0o600)

    def test_wrong_loaded_job_refuses_before_config_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);config=base/'config.json';config.write_bytes(b'original')
            with patch.object(install,'verify_loaded_job',side_effect=ValueError('wrong job')),patch.object(install.subprocess,'run') as run:
                with self.assertRaises(ValueError):install.retarget_config(base,base/'job.plist',[],{})
                run.assert_not_called()
            self.assertEqual(config.read_bytes(),b'original')

    def test_recovery_does_not_kick_job_that_changed_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);config=base/'config.json';config.write_bytes(b'original')
            with patch.object(install,'verify_loaded_job',side_effect=['gui/123/owned',ValueError('changed job')]),patch.object(install.subprocess,'run',side_effect=subprocess.CalledProcessError(1,[])) as run:
                with self.assertRaisesRegex(RuntimeError,'recovery unverified'):install.retarget_config(base,base/'job.plist',[],{})
                self.assertEqual(run.call_count,1)
            self.assertEqual(config.read_bytes(),b'original')

if __name__=='__main__':unittest.main()
