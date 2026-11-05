import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createBackupReplaySession} from '../server/restore-ndjson.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {auditRecovery} from '../server/recovery.mjs';

test('target-owned restore control cannot be forged, exported pending, or bypassed after dropping guards',()=>{
 const store=new RoomStore(':memory:');
 try {
  assert.throws(()=>store.db.prepare("UPDATE current_restore_admission SET state='pending',restore_id='raw' WHERE singleton=1").run(),/unsupported restore admission mutation/);
  store.assertRestoreAdmitted();
  store.db.exec('DROP TRIGGER current_restore_admission_update');
  assert.throws(()=>store.assertRestoreAdmitted(),/schema requires reconciliation/);
 } finally {store.close();}
});
test('stream restore remains fenced until final successful census, then ordinary reads resume with exact ledger',()=>{
 const source=new RoomStore(':memory:'),target=new RoomStore(':memory:');
 try {
  source.initialize(initialRoom(),{representation:'normalized-current-v1'});
  const exported=exportNdjsonText(source.db),session=createBackupReplaySession(target);
  assert.equal(target.db.prepare('SELECT state FROM current_restore_admission').get().state,'pending');
  assert.throws(()=>exportNdjsonText(target.db),error=>error.status===503&&error.code==='restore_incomplete');
  assert.throws(()=>target.headSequence('commons'),error=>error.status===503);
  session.writeText(exported);
  assert.throws(()=>target.readTransaction(()=>1),error=>error.status===503);
  session.finish();
  assert.equal(target.db.prepare('SELECT state FROM current_restore_admission').get().state,'clear');
  assert.equal(target.headSequence('commons'),source.headSequence('commons'));
  assert.deepEqual(target.db.prepare('SELECT * FROM operator_actions ORDER BY id').all(),source.db.prepare('SELECT * FROM operator_actions ORDER BY id').all());
  auditRecovery(target);
 }finally{source.close();target.close();}
});
