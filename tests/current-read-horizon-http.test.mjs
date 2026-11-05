import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {createRoomServer} from '../server/http.mjs';
import {isCurrentRoom} from '../server/current-room-repository.mjs';
async function fixture(t,{sinceJoin=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'current-read-horizon-')),file=join(dir,'room.sqlite');let store=new RoomStore(file),server;
 const events=initialRoom();if(sinceJoin)events.push(event({type:'room.history_visibility_set',roomId:'commons',actorId:'owner',data:{historyVisibility:'since_join'}}));
 store.initialize(events,{representation:'normalized-current-v1'});assert.equal(isCurrentRoom(store.db,'commons'),true);
 const owner=store.issueAccessKey('commons','owner');let id=0;
 const command=(type,data,key=owner)=>store.command(key,'commons',{id:'horizon-command-'+(++id),type,data});
 command('member.added',{memberId:'maya',displayName:'Maya',kind:'human',permissions:[]});
 command('member.added',{memberId:'other',displayName:'Other',kind:'human',permissions:[]});
 const maya=store.issueAccessKey('commons','maya'),other=store.issueAccessKey('commons','other');
 command('message.posted',{messageId:'root',body:'Public coordination'});
 command('message.posted',{messageId:'private',body:'Private coordination',toMemberId:'maya'});
 async function open(){server=createRoomServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));}
 async function close(){server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));}
 await open();t.after(async()=>{await close();store.close();rmSync(dir,{recursive:true,force:true});});
 const call=async(method,data,key=maya,query='')=>{const origin='http://127.0.0.1:'+server.address().port,r=await fetch(origin+'/api/rooms/commons/read-horizon'+query,{method,headers:{Origin:origin,Authorization:'Bearer '+key,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:r.status,body:await r.json()};};
 return{get store(){return store;},owner,maya,other,command,call,async reopen(){await close();store.close();store=new RoomStore(file);await open();}};
}
test('normalized read-horizon HTTP saves selected public/private positions and survives reload without whole room reads',async t=>{
 const f=await fixture(t);f.store.room=()=>{throw Error('Whole room read forbidden');};
 assert.equal((await f.call('GET')).body.lastReadMessageId,null);
 const saved=await f.call('POST',{lastReadMessageId:'root'});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.lastReadMessageId,'root');
 assert.equal((await f.call('POST',{peerMemberId:'owner',lastReadMessageId:'private'})).status,200);
 await f.reopen();f.store.room=()=>{throw Error('Whole room read forbidden after reload');};
 assert.equal((await f.call('GET')).body.lastReadMessageId,'root');assert.equal((await f.call('GET',undefined,f.maya,'?peerMemberId=owner')).body.lastReadMessageId,'private');
 assert.equal((await f.call('POST',{lastReadMessageId:null})).body.lastReadMessageId,null);assert.equal((await f.call('GET')).body.lastReadMessageId,null);
});
test('normalized horizon preserves private/history/credential refusals and does not mutate business history',async t=>{
 const f=await fixture(t,{sinceJoin:true}),db=f.store.db;
 for(const lastReadMessageId of ['private','missing']){const r=await f.call('POST',{lastReadMessageId},f.other);assert.equal(r.status,404,JSON.stringify(r.body));assert.equal(r.body.error.code,'message_not_found');}
 assert.equal((await f.call('POST',{peerMemberId:'other',lastReadMessageId:'private'})).status,404);
 const before=db.prepare('SELECT sequence,projection FROM rooms WHERE id=?').get('commons'),counts=()=>['events','commands','current_room_records','current_room_record_proofs'].map(name=>db.prepare('SELECT count(*) n FROM '+name).get().n),beforeCounts=counts(),prepare=db.prepare.bind(db),writes=[];
 db.prepare=sql=>{const stmt=prepare(sql);if(/^(?:INSERT|UPDATE|DELETE)/.test(sql)){const run=stmt.run.bind(stmt);stmt.run=(...args)=>{writes.push(sql);return run(...args);};}return stmt;};
 try{assert.equal((await f.call('POST',{lastReadMessageId:'root'})).status,200);}finally{db.prepare=prepare;}
 assert.equal(writes.length,1,JSON.stringify(writes));assert.equal(writes.filter(s=>s.startsWith('INSERT INTO read_horizons')).length,1);assert.ok(!writes.some(s=>/^(?:UPDATE rooms|INSERT INTO events|INSERT INTO commands|UPDATE current_room_)/.test(s)),JSON.stringify(writes));assert.deepEqual(db.prepare('SELECT sequence,projection FROM rooms WHERE id=?').get('commons'),before);assert.deepEqual(counts(),beforeCounts);
 f.command('member.added',{memberId:'late',displayName:'Late',kind:'human',permissions:[]});const late=f.store.issueAccessKey('commons','late');assert.equal((await f.call('POST',{lastReadMessageId:'root'},late)).status,404);
 assert.equal((await f.call('POST',{lastReadMessageId:'root'},'invalid')).status,401);
});
test('horizon save fault rolls back the selected marker and cold retry persists it',async t=>{
 const f=await fixture(t),db=f.store.db,prepare=db.prepare.bind(db);let fired=false;
 db.prepare=sql=>{const stmt=prepare(sql);if(sql.includes('INSERT INTO read_horizons')){const run=stmt.run.bind(stmt);stmt.run=(...args)=>{run(...args);fired=true;throw Error('Synthetic horizon save fault');};}return stmt;};
 try{assert.equal((await f.call('POST',{lastReadMessageId:'root'})).status,500);}finally{db.prepare=prepare;}
 assert.equal(fired,true);assert.equal(db.prepare('SELECT count(*) n FROM read_horizons').get().n,0);await f.reopen();assert.equal((await f.call('POST',{lastReadMessageId:'root'})).status,200);assert.equal((await f.call('GET')).body.lastReadMessageId,'root');
});
