import {ProjectRoom} from './room.mjs';
import {seedRecoveryInvitationSource,rebindRecoveryInvitee} from '../tests/helpers/recovery-invitation-source.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {createBackupReplaySession} from '../server/restore-ndjson.mjs';
import {restoreProgress,withRestoreTransaction} from '../server/restore-admission.mjs';
export class InvitationRecoveryRoom extends ProjectRoom{
 async fetch(request){const u=new URL(request.url),store=this.store,db=store.db;
  if(u.pathname==='/__seed')return Response.json(seedRecoveryInvitationSource(store,{pending:17,beforeCapture(s,context){rebindRecoveryInvitee(s,context);const clock=s.now;let offset=0;s.now=()=>clock()+offset;for(let i=0;i<40;i++){offset+=3000;s.command(context.key,'legacy-room',{id:'native-later-'+i,type:'message.posted',data:{messageId:'native-later-'+i,body:'Unrelated later history '+i}});}}}).expected);
  if(u.pathname==='/__export')return new Response(exportNdjsonText(db));
  if(u.pathname==='/__progress')return Response.json(restoreProgress(db));
  if(u.pathname==='/__partial'){const text=await request.text(),session=createBackupReplaySession(store,{staged:true});session.writeText(text.slice(0,text.lastIndexOf('{"kind":"trailer"')));return Response.json({pending:restoreProgress(db).state==='pending'});}
  if(u.pathname==='/__corrupt'){
   withRestoreTransaction(store,()=>{const definitions=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='membership_invitation_journal'").all();for(const d of definitions)db.exec('DROP TRIGGER "'+d.name+'"');db.prepare('UPDATE membership_invitation_journal SET checksum=? WHERE rowid=(SELECT MIN(rowid) FROM membership_invitation_journal)').run('0'.repeat(64));for(const d of definitions)db.exec(d.sql);});return Response.json({corrupted:true});
  }
  store.room=()=>{throw Error('whole room hydration');};
  const original=db.prepare.bind(db),observe=db.observeStatement,cost={statements:0,rowsRead:0,rowsWritten:0,unknown:0};let fired=false;
  db.observeStatement=()=>sample=>{cost.statements++;for(const k of ['rowsRead','rowsWritten'])if(sample[k]===null)cost.unknown++;else cost[k]+=sample[k];};
  if(u.searchParams.has('fault'))db.prepare=sql=>{const statement=original(sql),run=statement.run.bind(statement);if(sql.startsWith('UPDATE current_restore_admission SET phase='))statement.run=(...args)=>{run(...args);fired=true;throw Error('invitation continuation checkpoint fault');};return statement;};
  let response;try{response=await super.fetch(request);}finally{db.prepare=original;db.observeStatement=observe;}
  const headers=new Headers(response.headers);headers.set('x-fixture-cost',JSON.stringify(cost));headers.set('x-fixture-fault',String(fired));return new Response(response.body,{status:response.status,headers});
 }
}
export default{fetch(request,env){const u=new URL(request.url),surface=u.searchParams.get('surface')??'target';u.searchParams.delete('surface');const headers=new Headers(request.headers);headers.set('host','room.example.test');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName(surface).fetch(new Request(u,{method:request.method,headers,...(!['GET','HEAD'].includes(request.method)?{body:request.body}:{})}));}};
