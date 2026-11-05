import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {readCurrentRecord} from '../server/current-room-repository.mjs';
import {auditRecovery} from '../server/recovery.mjs';
function setup(t,{count=2,native=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'native-capabilities-')),path=join(dir,'room.sqlite');let store=new RoomStore(path);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const es=initialRoom();for(let i=1;i<count;i++)es.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:`worker-${i}`,displayName:`Researcher ${i}`,kind:'agent',permissions:[]}}));
 store.initialize(es,native?{representation:'normalized-current-v1'}:undefined);
 const key=store.issueAccessKey('commons','worker-1');
 const forbid=()=>{if(native)store.room=()=>{throw Error('Full room hydration forbidden');};};forbid();
 return{get store(){return store;},key,command:(id,caps)=>store.command(key,'commons',{id,type:'capabilities.advertised',data:{capabilities:caps}}),restart:()=>{store.close();store=new RoomStore(path);forbid();}};
}
test('native capabilities uses one protected actor at legal 100-member size and survives cold exact retry',t=>{
 const f=setup(t,{count:100}),before=readCurrentRecord(f.store.db,'commons','members','worker-1'),other=readCurrentRecord(f.store.db,'commons','members','worker-99');
 const saved=f.command('advertise',[' code-review ','code-review','research']);
 const after=readCurrentRecord(f.store.db,'commons','members','worker-1');
 assert.deepEqual(after.capabilities,['code-review','research']);assert.equal(after.revision,before.revision);assert.deepEqual(after.permissions,before.permissions);assert.equal(after.updatedAt,saved.event.at);
 assert.deepEqual(readCurrentRecord(f.store.db,'commons','members','worker-99'),other);
 f.restart();assert.equal(f.command('advertise',[' code-review ','code-review','research']).event.id,saved.event.id);assert.equal(f.command('advertise',[' code-review ','code-review','research']).duplicate,true);
 assert.throws(()=>f.command('advertise',['other']),e=>e.code==='idempotency_conflict');
 assert.doesNotThrow(()=>auditRecovery(f.store));
});
test('native capability failed save rolls back member proof, event, receipt and closed writer before retry',t=>{
 const f=setup(t),member=readCurrentRecord(f.store.db,'commons','members','worker-1'),before=f.store.db.prepare('SELECT count(*) n FROM events').get().n;
 const receipts=f.store.db.prepare('SELECT count(*) n FROM operator_actions').get().n,commands=f.store.db.prepare('SELECT count(*) n FROM commands').get().n;
 const prepare=f.store.db.prepare.bind(f.store.db);f.store.db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('UPDATE rooms SET sequence=')){const run=statement.run.bind(statement);statement.run=(...args)=>{run(...args);throw Error('Synthetic capability save interrupted');};}return statement;};
 assert.throws(()=>f.command('fault',['research']),/Synthetic capability save interrupted/);f.store.db.prepare=prepare;
 assert.deepEqual(readCurrentRecord(f.store.db,'commons','members','worker-1'),member);assert.equal(f.store.db.prepare('SELECT count(*) n FROM events').get().n,before);assert.equal(f.store.db.prepare('SELECT enabled FROM current_room_writer_permit').get().enabled,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM operator_actions').get().n,receipts);assert.equal(f.store.db.prepare('SELECT count(*) n FROM commands').get().n,commands);
 f.restart();assert.equal(f.command('fault',['research']).duplicate,false);assert.equal(f.command('fault',['research']).duplicate,true);
 assert.throws(()=>f.command('empty',[]),e=>e.status===422);assert.throws(()=>f.command('too-many',Array.from({length:31},(_,i)=>`skill${i}`)),e=>e.status===422);
 assert.doesNotThrow(()=>auditRecovery(f.store));
});
for(const native of [false,true])test(`${native?'native':'legacy'} capabilities preserves self-description while guidance uses its supported work contract`,t=>{
 const f=setup(t,{native});f.command('advertise',['research']);const result=f.store.capabilities(f.key,'commons');
 assert.equal(result.members[0].memberId,'worker-1');assert.equal(result.next[0].action,'delegate-work');
 assert.equal(result.next[0].path,native?'/api/rooms/commons/commands':'/api/rooms/commons/collab/assignments');
 if(native){assert.match(result.next[0].description,/work.proposed/);assert.match(result.next[0].description,/requires acceptance/);const proposed=f.store.command(f.store.issueAccessKey('commons','owner'),'commons',{id:'proposal',type:'work.proposed',data:{workItemId:'research-task',title:'Research sources',definitionOfDone:'Three verified sources saved',accountableMemberId:'worker-1',mode:'read'}});assert.equal(proposed.event.type,'work.proposed');const ref=readCurrentRecord(f.store.db,'commons','workItems','research-task');assert.equal(ref.id,'research-task');}else assert.match(result.next[0].description,/assignee/);
});
