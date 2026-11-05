// Isolated synthetic workerd qualification; never deployed.
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { repairLegacyMessages } from '../server/operator-legacy-message-repair.mjs';
import { seedLegacyFixture } from '../tests/helpers/legacy-session-fixture.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
export class LegacySessionRepairRoom extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.db=new DurableDatabase(ctx.storage);
    this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage});
  }
  async fetch(request) {
    const path=new URL(request.url).pathname,s=this.store,db=this.db;
    try {
      if(path==='/seed')return Response.json({request:seedLegacyFixture(s).request});
      if(path==='/seed-adopt') {
        const fixture=seedLegacyFixture(s);
        s.transaction(()=>{const state=structuredClone(s.room('legacy-room').state);
          for(const message of state.messages)delete message.channelId;
          for(const item of Object.values(state.workItems)){delete item.round_count;delete item.tool_calls;delete item.suspended_by;}
          db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(s.storedProjection('legacy-room',state),'legacy-room');s.rememberReconstructedRoomProof('legacy-room');});
        db.prepare("UPDATE messages SET entity_hash=NULL WHERE room_id='legacy-room'").run();
        return Response.json({request:{...fixture.request,messageProofMode:'adopt-absent-inline-v1'}});
      }
      if(path==='/utf8-valid') {
        db.prepare("UPDATE events SET body=json_set(body,'$.data.note',char(65533)) WHERE json_extract(body,'$.type')='work.accepted'").run();
        return Response.json({changed:true});
      }
      if(path==='/utf8-invalid'||path==='/utf8-restore') {
        const [from,to]=path==='/utf8-invalid'?['efbfbd','80']:['80','efbfbd'];
        db.prepare(`UPDATE events SET body=replace(body,CAST(x'${from}' AS TEXT),CAST(x'${to}' AS TEXT)) WHERE id='synthetic-4'`).run();
        return Response.json({changed:true});
      }
      if(path==='/plan'||path==='/execute')return Response.json(repairLegacyMessages(s,await request.json(),path==='/execute'));
      if(path==='/audit-fault') {
        db.exec("CREATE TRIGGER fail_repair BEFORE INSERT ON operator_actions WHEN NEW.action='legacy_session_backfill_reconciled' BEGIN SELECT RAISE(ABORT,'synthetic audit storage failure'); END");
        return Response.json({installed:true});
      }
      if(path==='/clear-fault') {db.exec('DROP TRIGGER fail_repair');return Response.json({removed:true});}
      if(path==='/lose-replay-checkpoints') {
        s.transaction(()=>{
          db.prepare("DELETE FROM message_replay_snapshots WHERE room_id='legacy-room'").run();
          db.prepare('DELETE FROM messages_backfill_state WHERE room_id IN (?,?)').run('legacy-room','legacy-room\0anchor');
          db.prepare("DELETE FROM projection_checkpoints WHERE room_id='legacy-room'").run();
        });
        return Response.json({removed:true});
      }
      if(path==='/recover-saved') {
        const replay=s.rebuildProjection('legacy-room'),result=s.backfillMessages({limit:64});
        return Response.json({replay,result,parity:s.checkMessagesParity({roomId:'legacy-room'})});
      }
      if(path==='/append'||path==='/append-only') {
        const key=s.issueAccessKey('legacy-room','owner');
        s.command(key,'legacy-room',{id:'after-repair',type:'message.posted',data:{messageId:'after-repair',body:'Synthetic later message'}});
        if(path==='/append')s.backfillMessages({limit:64});
        return Response.json({appended:true});
      }
      if(path==='/state') {
        const authority=Object.fromEntries(['rooms','messages','work_entities','integrity_room_state'].map(table=>[table,db.prepare(`SELECT * FROM ${table} WHERE ${table==='rooms'?'id':'room_id'}=?`).all('legacy-room')]));
        return Response.json({authority,head:s.headSequence('legacy-room'),cursor:db.prepare("SELECT * FROM messages_backfill_cursor WHERE room_id='legacy-room'").get(),
          blocks:db.prepare("SELECT count(*) AS n FROM messages_backfill_blocks WHERE room_id='legacy-room'").get().n,
          receipts:db.prepare("SELECT count(*) AS n FROM operator_actions WHERE action='legacy_session_backfill_reconciled'").get().n});
      }
      return new Response('Not found',{status:404});
    } catch(error) {return Response.json({error:{code:error.code??'internal',message:String(error.message).slice(0,160)}},{status:error.status??500});}
  }
}
export default {fetch(request,env){return env.ROOM.getByName('legacy-session-repair').fetch(request);}};
