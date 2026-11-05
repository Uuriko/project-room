import {ProjectRoom} from './room.mjs';
import {seedRecoveryReminderSource} from '../tests/helpers/recovery-reminder-source.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {createBackupReplaySession} from '../server/restore-ndjson.mjs';
import {restoreProgress} from '../server/restore-admission.mjs';
export class ReminderConsumptionRoom extends ProjectRoom{
 async fetch(request){const u=new URL(request.url),store=this.store,db=store.db;
  if(u.pathname==='/__seed'){const r=seedRecoveryReminderSource(store,{current:true,receipts:150});return Response.json({receipts:r.receipts,reminders:r.reminders});}
  if(u.pathname==='/__export')return new Response(exportNdjsonText(db));
  if(u.pathname==='/__progress')return Response.json(restoreProgress(db));
  if(u.pathname==='/__partial'){const text=await request.text(),session=createBackupReplaySession(store,{staged:true});session.writeText(text.slice(0,text.lastIndexOf('{"kind":"trailer"')));return Response.json({pending:restoreProgress(db).state==='pending'});}
  const original=db.prepare.bind(db),scans={private_reminders:0,private_reminder_commands:0};let fired=false;
  db.prepare=sql=>{const statement=original(sql),table=/^SELECT \* FROM (private_reminders|private_reminder_commands)$/.exec(sql)?.[1];if(table){const all=statement.all.bind(statement);statement.all=(...args)=>{scans[table]++;return all(...args);};}if(u.searchParams.has('fault')&&sql.startsWith('UPDATE current_restore_admission SET state=')){const run=statement.run.bind(statement);statement.run=(...args)=>{run(...args);fired=true;throw Error('reminder publication checkpoint fault');};}return statement;};
  let response;try{response=await super.fetch(request);}finally{db.prepare=original;}
  const headers=new Headers(response.headers);headers.set('x-fixture-scans',JSON.stringify(scans));headers.set('x-fixture-fault',String(fired));return new Response(response.body,{status:response.status,headers});
 }
}
export default{fetch(request,env){const u=new URL(request.url),surface=u.searchParams.get('surface')??'target';u.searchParams.delete('surface');const headers=new Headers(request.headers);headers.set('host','room.example.test');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName(surface).fetch(new Request(u,{method:request.method,headers,...(!['GET','HEAD'].includes(request.method)?{body:request.body}:{})}));}};
