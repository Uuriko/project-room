// Synthetic fixture only. Never deploy this entry point.
import worker, { ProjectRoom } from './room.mjs';
import { createHash } from 'node:crypto';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class LegacyRepairProbe extends ProjectRoom {
  async fetch(request) {
    const path = new URL(request.url).pathname, store = this.store, db = store.db;
    if (path === '/__fixture/seed') {
      for (const roomId of ['repair-target','repair-second','repair-other']) {
        store.initialize([...initialRoom(roomId), event({ type:'message.posted', roomId, actorId:'owner', id:`posted-${roomId}`, at:new Date().toISOString(),
          data:{ messageId:'card', body:'Synthetic private body', kind:'receipt_card', claimId:'claim', receiptId:'explicit-receipt', title:'Done', closedBy:'Owner', deliveryMode:'merged', evidence:'Synthetic evidence' } })]);
      }
      while (!store.backfillMessages({limit:1000}).done) { /* bounded fixture */ }
      for (const roomId of ['repair-target','repair-second','repair-other']) store.checkMessagesParity({roomId});
      db.exec("UPDATE messages SET record_json=json_set(record_json,'$.receiptId',NULL,'$.reactions',json('{\"watch\":[\"owner\"]}')),reactions_json='{\"watch\":[\"owner\"]}' WHERE room_id='repair-target'");
      store.recordIntegrityFailure('messages_parity','repair-target',new Error('messages parity failed for repair-target: current record card differs'));
      return Response.json({head:db.prepare("SELECT sequence FROM rooms WHERE id='repair-target'").get().sequence});
    }
    if (path === '/__fixture/second') {
      db.exec("UPDATE messages SET record_json=json_remove(record_json,'$.receiptId') WHERE room_id='repair-second'");
      store.recordIntegrityFailure('messages_parity','repair-second',new Error('messages parity failed for repair-second: current record card differs'));
      return Response.json({head:db.prepare("SELECT sequence FROM rooms WHERE id='repair-second'").get().sequence});
    }
    if (path === '/__fixture/state') {
      const row=db.prepare("SELECT record_json,reactions_json FROM messages WHERE room_id='repair-target'").get();
      return Response.json({
        source:digest({rooms:db.prepare('SELECT * FROM rooms ORDER BY id').all(),events:db.prepare('SELECT * FROM events ORDER BY room_id,sequence').all()}),
        target:digest(db.prepare("SELECT * FROM messages WHERE room_id='repair-target'").all()),
        other:digest({rows:db.prepare("SELECT * FROM messages WHERE room_id='repair-other'").all(),cursor:db.prepare("SELECT * FROM messages_backfill_cursor WHERE room_id='repair-other'").all()}),
        failures:store.integrityFailures().map(({step,recordId,failures})=>({step,recordId,failures})),
        certificate:db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id='repair-target'").get().parity_at_seq,
        repaired:JSON.parse(row.record_json).receiptId==='explicit-receipt' && !Object.hasOwn(JSON.parse(row.record_json),'reactions') && row.reactions_json===null,
        secondRepaired:JSON.parse(db.prepare("SELECT record_json FROM messages WHERE room_id='repair-second'").get().record_json).receiptId==='explicit-receipt',
        completions:db.prepare("SELECT count(*) AS n FROM operator_actions WHERE action='legacy_messages_repaired'").get().n
      });
    }
    if (path === '/__fixture/fail-verify') {
      db.exec("CREATE TRIGGER fail_target_verify BEFORE UPDATE ON messages_backfill_cursor WHEN NEW.room_id='repair-target' AND NEW.parity_at_seq IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected canonical failure'); END");
      return Response.json({injected:true});
    }
    if (path === '/__fixture/fail-audit') {
      db.exec("CREATE TRIGGER fail_repair_audit BEFORE INSERT ON operator_actions WHEN NEW.action='legacy_messages_repaired' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END");
      return Response.json({injected:true});
    }
    return super.fetch(request);
  }
}
export default worker;
