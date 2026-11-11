import assert from 'node:assert/strict';
import {CURRENT_ROOM_GUARDS} from '../../server/current-room-repository.mjs';
// Test-only reconciliation of a known archived experimental runtime's unused
// target. Never upgrade an existing room or accept a mixed/unknown old guard.
export function transitionEmptyCurrentPermit(store,oldCurrent) {
 assert.equal(store.db.isTransaction,true);
 assert.equal(oldCurrent.CURRENT_WRITER_FORMAT,'normalized-current-v1-native-work-5');
 oldCurrent.verifyCurrentRoomSchema(store.db);
 for(const table of ['rooms','events','commands','messages','work_entities','current_room_head','current_room_records','current_room_record_proofs','current_restore_audit_scratch'])
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM '+table).get().n,0,'fixture transition requires empty '+table);
 const definition=CURRENT_ROOM_GUARDS.match(/CREATE TRIGGER IF NOT EXISTS current_room_permit_update[\s\S]*?(?=\nCREATE TRIGGER IF NOT EXISTS current_room_permit_insert)/)?.[0];
 assert.ok(definition,'current code owns the permit guard');
 store.db.exec('DROP TRIGGER current_room_permit_update');
 store.db.exec(definition);
}
