import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createRoomServer} from '../server/http.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {operatorNormalization} from '../server/operator-normalization.mjs';

test('normalized owner exports redacted public history, never private DMs, without full room hydration',async t=>{
 const s=new RoomStore(':memory:');s.initialize(initialRoom());const key=s.issueAccessKey('commons','owner');
 const send=(type,data,token=key)=>s.command(token,'commons',{id:randomUUID(),type,data});
 for(const id of ['a','b'])send('member.added',{memberId:id,displayName:id,kind:'human',permissions:[]});
 const a=s.issueAccessKey('commons','a'),b=s.issueAccessKey('commons','b');
 send('message.posted',{messageId:'public',body:'obsolete text'});send('message.edited',{messageId:'public',body:'current text',expectedMessageRevision:0});
 send('message.posted',{messageId:'deleted',body:'erased text'});send('message.deleted',{messageId:'deleted',expectedMessageRevision:0});
 send('message.posted',{messageId:'private',body:'private original',toMemberId:'b'},a);
 send('message.edited',{messageId:'private',body:'private replacement',expectedMessageRevision:0},a);
 for(let i=0;i<25;i++)send('message.posted',{messageId:'p'+i,body:'public row '+i});
 const plan=operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true});operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true,planHash:plan.planHash,requestId:'export-test',reason:'Synthetic export test'},true);
 s.room=()=>{throw Error('forbidden full-room hydration');};
 const server=createRoomServer({store:s});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));s.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 const get=(format,token=key)=>fetch(origin+'/api/rooms/commons/export?format='+format,{headers:{Authorization:'Bearer '+token}});
 assert.equal((await get('jsonl',b)).status,403);
 for(const format of ['jsonl','html']){
  const before=s.headSequence('commons'),res=await get(format),body=await res.text();assert.equal(res.status,200,body);
  assert.equal(Number(res.headers.get('content-length')),Buffer.byteLength(body));assert.match(body,/current text/);assert.doesNotMatch(body,/obsolete text|erased text|private original|private replacement/);
  assert.equal(s.headSequence('commons'),before+1);
  if(format==='jsonl'){const rows=body.trim().split('\n').map(JSON.parse);assert.deepEqual(rows.map(r=>r.sequence),rows.map((_,i)=>i+1));assert.ok(rows.length>16);}
 }
 // A later source-page failure cannot become a plausible successful prefix.
 const beforeFailure=s.headSequence('commons'),eventsAfter=s.eventsAfter.bind(s);
 s.eventsAfter=(...args)=>{if(args[2]>0)throw Error('injected export page failure');return eventsAfter(...args);};
 const failed=await get('jsonl');assert.equal(failed.status,500);assert.doesNotMatch(await failed.text(),/current text|public row/);assert.equal(s.headSequence('commons'),beforeFailure);s.eventsAfter=eventsAfter;
 const command=s.command.bind(s);s.command=(...args)=>{if(args[2].type==='room.exported')throw Error('injected export audit failure');return command(...args);};
 const unaudited=await get('html');assert.equal(unaudited.status,500);assert.doesNotMatch(await unaudited.text(),/current text|public row/);assert.equal(s.headSequence('commons'),beforeFailure);s.command=command;
 const repaired=await get('jsonl');assert.equal(repaired.status,200);assert.equal(s.headSequence('commons'),beforeFailure+1);
 assert.doesNotThrow(()=>auditRecovery(s));
 const last=s.db.prepare("SELECT body FROM events WHERE room_id='commons' ORDER BY sequence DESC LIMIT 1").get();assert.equal(JSON.parse(last.body).type,'room.exported');
});
