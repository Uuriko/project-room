import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {createRoomServer} from '../server/http.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {readCurrentPinsWindow} from '../server/current-pins.mjs';
async function setup(t,{sinceJoin=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'current-pins-http-')),file=join(dir,'room.sqlite');let store=new RoomStore(file),server,id=0;
 const events=initialRoom();if(sinceJoin)events.push(event({type:'room.history_visibility_set',roomId:'commons',actorId:'owner',data:{historyVisibility:'since_join'}}));store.initialize(events,{representation:'normalized-current-v1'});const keys={owner:store.issueAccessKey('commons','owner')};
 const command=(actor,type,data,commandId='pins-command-'+(++id))=>store.command(keys[actor],'commons',{id:commandId,type,data});
 for(const memberId of ['alice','bob','mallory']){command('owner','member.added',{memberId,displayName:memberId,kind:'human',permissions:[]});keys[memberId]=store.issueAccessKey('commons',memberId);}
 async function open(){server=createRoomServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));}
 async function close(){server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));}
 await open();t.after(async()=>{await close();store.close();rmSync(dir,{recursive:true,force:true});});
 const call=async(actor,path='/pins',data)=>{const origin='http://127.0.0.1:'+server.address().port,r=await fetch(origin+'/api/rooms/commons'+path,{method:data===undefined?'GET':'POST',headers:{Origin:origin,Authorization:'Bearer '+keys[actor],...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:r.status,body:await r.json()};};
 return{get store(){return store;},keys,command,call,async reopen(){await close();store.close();store=new RoomStore(file);await open();}};
}
test('normalized pin/unpin uses original canonical messages, exact command retry, cold reads and activation context',async t=>{
 const f=await setup(t);f.command('owner','message.posted',{messageId:'root',body:'Keep this guidance'});f.command('alice','message.posted',{messageId:'reply',body:'Useful reply',replyToId:'root'});
 const posted=await f.call('bob','/pins',{messageId:'reply',pinned:true,requestId:'pin-exact'});assert.equal(posted.status,201,JSON.stringify(posted.body));
 const pin=f.command('bob','message.pinned',{messageId:'reply'},'pin-exact');assert.equal(pin.event.data.pinDmPartyPolicyVersion,1);const retry=f.command('bob','message.pinned',{messageId:'reply'},'pin-exact');assert.equal(retry.duplicate,true);assert.equal(retry.sequence,pin.sequence);
 assert.doesNotThrow(()=>auditRecovery(f.store));await f.reopen();f.store.room=()=>{throw Error('No whole-room pin read');};
 const listed=await f.call('bob');assert.equal(listed.status,200,JSON.stringify(listed.body));assert.equal(listed.body.contractVersion,2);assert.deepEqual(listed.body.pins.map(p=>[p.messageId,p.body]),[['reply','Useful reply']]);
 const activation=await f.call('bob','/activation-pack');assert.equal(activation.status,200,JSON.stringify(activation.body));assert.deepEqual(activation.body.pinnedResources.map(p=>p.messageId),['reply']);assert.equal(activation.body.pinWindow.sourceWindow.complete,true);
 assert.equal((await f.call('bob','/pins',{messageId:'reply',pinned:true,requestId:'lost-ack-existing'})).status,200);
 const removed=await f.call('bob','/pins',{messageId:'reply',pinned:false,requestId:'unpin-exact'});assert.equal(removed.status,201,JSON.stringify(removed.body));assert.deepEqual(removed.body.pins,[]);await f.reopen();assert.deepEqual((await f.call('bob')).body.pins,[]);assert.doesNotThrow(()=>auditRecovery(f.store));
});
test('bounded pin pages preserve hidden-only continuation without private ids/counts and reject viewer/head/restart rebinding',async t=>{
 const f=await setup(t);for(let i=0;i<4;i++){f.command('alice','message.posted',{messageId:'private-pin-'+i,body:'Private retained guidance',toMemberId:'bob'});f.command('bob','message.pinned',{messageId:'private-pin-'+i});}
 for(let i=0;i<2;i++){f.command('owner','message.posted',{messageId:'public-pin-'+i,body:'Public retained guidance '+i});f.command('alice','message.pinned',{messageId:'public-pin-'+i});}
 const snapshot=await f.call('owner','');assert.equal(snapshot.status,200,JSON.stringify(snapshot.body));assert.ok(!JSON.stringify(snapshot.body).includes('private-pin-'));assert.ok(!JSON.stringify(snapshot.body).includes('Private retained guidance'));assert.equal(snapshot.body.pinsWindow.complete,false);assert.equal(snapshot.body.pinsWindow.nextRead.path,'/api/rooms/commons/pins');
 const partySnapshot=await f.call('bob','');assert.equal(partySnapshot.status,200);assert.ok(partySnapshot.body.state.pins.some(pin=>pin.messageId==='private-pin-0'));
 const first=await f.call('owner');assert.equal(first.status,200,JSON.stringify(first.body));assert.deepEqual(first.body.pins,[]);assert.equal(first.body.count,0);assert.equal(first.body.page.hasMore,true);assert.ok(!JSON.stringify(first.body).includes('private-pin-'));assert.ok(!Object.hasOwn(first.body,'total'));
 const next=first.body.page.nextRead.path.replace('/api/rooms/commons',''),second=await f.call('owner',next);assert.deepEqual(second.body.pins.map(p=>p.messageId),['public-pin-0','public-pin-1']);assert.equal(second.body.sourceWindow.complete,true);
 assert.equal((await f.call('mallory',next)).status,422);
 for(const messageId of ['private-pin-0','missing']){const r=await f.call('owner','/pins',{messageId,pinned:true});assert.equal(r.status,404,JSON.stringify(r.body));assert.equal(r.body.error.code,'message_not_found');}
 const head=f.store.headSequence('commons');assert.throws(()=>f.command('mallory','message.pinned',{messageId:'private-pin-0'}),/not a party/);assert.throws(()=>f.command('owner','message.unpinned',{messageId:'private-pin-0'}),/not a party/);assert.equal(f.store.headSequence('commons'),head);
 const bob=await f.call('bob');assert.equal(bob.body.pins.length,4);const old=first.body.page.nextCursor;f.command('owner','message.posted',{messageId:'head-changed',body:'New head'});assert.equal((await f.call('owner','/pins?cursor='+old)).status,422);
 const live=(await f.call('owner')).body.page.nextCursor;await f.reopen();assert.equal((await f.call('owner','/pins?cursor='+live)).status,422);assert.doesNotThrow(()=>auditRecovery(f.store));
});
test('pin save fault rolls back canonical pinned column/witness/head and exact retry succeeds',async t=>{
 const f=await setup(t);f.command('owner','message.posted',{messageId:'fault-target',body:'Original'});const db=f.store.db,before=db.prepare('SELECT seq,pinned,entity_hash FROM messages WHERE room_id=? AND message_id=?').get('commons','fault-target'),head=f.store.headSequence('commons'),prepare=db.prepare.bind(db);let fired=false;
 db.prepare=sql=>{const stmt=prepare(sql);if(sql.startsWith('INSERT INTO current_room_head')){const run=stmt.run.bind(stmt);stmt.run=(...args)=>{run(...args);fired=true;throw Error('Synthetic pin head fault');};}return stmt;};
 try{assert.equal((await f.call('owner','/pins',{messageId:'fault-target',pinned:true,requestId:'pin-fault'})).status,500);}finally{db.prepare=prepare;}
 assert.equal(fired,true);assert.equal(f.store.headSequence('commons'),head);assert.deepEqual(db.prepare('SELECT seq,pinned,entity_hash FROM messages WHERE room_id=? AND message_id=?').get('commons','fault-target'),before);await f.reopen();assert.equal((await f.call('owner','/pins',{messageId:'fault-target',pinned:true,requestId:'pin-fault'})).status,201);assert.doesNotThrow(()=>auditRecovery(f.store));
 assert.throws(()=>readCurrentPinsWindow(f.store,'commons','owner'),/read transaction/);
});

test('normalized pin bodies and writes honor prejoin floors without losing the owner pin',async t=>{
 const f=await setup(t,{sinceJoin:true});f.command('owner','message.posted',{messageId:'before-join',body:'Earlier retained guidance'});f.command('owner','message.pinned',{messageId:'before-join'});
 f.command('owner','member.added',{memberId:'late',displayName:'Late',kind:'human',permissions:[]});f.keys.late=f.store.issueAccessKey('commons','late');
 const late=await f.call('late');assert.equal(late.status,200,JSON.stringify(late.body));assert.deepEqual(late.body.pins,[]);assert.equal(late.body.sourceWindow.complete,true);assert.equal((await f.call('late','/pins',{messageId:'before-join',pinned:true})).status,404);
 assert.deepEqual((await f.call('owner')).body.pins.map(p=>p.messageId),['before-join']);
});

test('all50 canonical pins remain discoverable in bounded pages and the original capacity stays enforced',async t=>{
 const f=await setup(t);let clock=Date.now();f.store.now=()=>clock;for(let i=0;i<51;i++){clock+=3000;f.command('owner','message.posted',{messageId:'capacity-'+i,body:'Guidance '+i});if(i<50){clock+=3000;f.command('owner','message.pinned',{messageId:'capacity-'+i});}}
 const head=f.store.headSequence('commons');assert.throws(()=>f.command('owner','message.pinned',{messageId:'capacity-50'}),/Pin capacity/);assert.equal(f.store.headSequence('commons'),head);
 const seen=[];let path='/pins',calls=0;while(path){const r=await f.call('owner',path);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(r.body.pins.length<=4);seen.push(...r.body.pins.map(p=>p.messageId));path=r.body.page.nextRead?.path.replace('/api/rooms/commons','')??null;assert.ok(++calls<=13);}
 assert.equal(calls,13);assert.equal(new Set(seen).size,50);assert.deepEqual(seen,Array.from({length:50},(_,i)=>'capacity-'+i));assert.doesNotThrow(()=>auditRecovery(f.store));
});
