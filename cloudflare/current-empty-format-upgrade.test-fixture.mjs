import {ProjectRoom} from './room.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
export class EmptyFormatUpgradeRoom extends ProjectRoom {
 async fetch(request){const s=this.store,path=new URL(request.url).pathname;
  if(path==='/__seed'){
   s.initialize(initialRoom('legacy-preserved'),{representation:null});s.createAccount('kept-account');
   const key=s.issueAccessKey('legacy-preserved','owner');
   const before=s.db.prepare('SELECT hash,room_id,member_id,revoked FROM credentials ORDER BY hash').all();
   s.transaction(()=>{
    if(s.db.prepare('SELECT 1 FROM current_room_head LIMIT 1').get())throw Error('fixture requires unused current namespace');
    const rows=s.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND (name='current_room_permit_update' OR name LIKE 'current_restore_%')").all();
    for(const row of rows){if(!row.sql.includes('normalized-current-v1-native-work-6'))continue;s.db.exec('DROP TRIGGER '+row.name);s.db.exec(row.sql.replaceAll('normalized-current-v1-native-work-6','normalized-current-v1-native-work-5'));}
    s.db.exec('DELETE FROM room_schema_stamp');
   });
   return Response.json({key,before});
  }
  if(path==='/__facts')return Response.json({pending:s.restoreStatus().pending,member:s.authenticate(request.headers.get('x-fixture-key'),'legacy-preserved').member.id,credentials:s.db.prepare('SELECT hash,room_id,member_id,revoked FROM credentials ORDER BY hash').all(),account:Boolean(s.db.prepare('SELECT 1 FROM accounts WHERE id=?').get('kept-account'))});
  return super.fetch(request);
 }
}
export default {fetch(request,env){return env.ROOM.getByName('upgrade').fetch(request);}};
