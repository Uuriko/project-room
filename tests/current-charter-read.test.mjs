import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createRoomServer} from '../server/http.mjs';
import {validateCharterRead} from '../src/room-charter.js';
async function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'current-charter-read-')),file=join(dir,'room.sqlite');let store=new RoomStore(file),server;
 store.initialize(initialRoom(),{representation:'normalized-current-v1'});const key=store.issueAccessKey('commons','owner');
 let n=0;const send=data=>store.command(key,'commons',{id:'charter-'+(++n),type:'room.charter_updated',data});
 async function open(){server=createRoomServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));}
 async function close(){server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));}
 await open();t.after(async()=>{await close();store.close();rmSync(dir,{recursive:true,force:true});});
 const read=async(query='',token=key)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/rooms/commons/charter'+query,{headers:{Authorization:'Bearer '+token}});return{status:response.status,link:response.headers.get('Link'),body:await response.json()};};
 return{get store(){return store;},key,send,read,async reopen(){await close();store.close();store=new RoomStore(file);await open();}};
}
const data=(expectedRevision,purpose)=>({expectedRevision,purpose,outputs:'Saved work',boundaries:null,escalation:'Ask the owner'});
test('normalized standalone instructions serve exact current/default and unset versions over HTTP and cold reload',async t=>{
 const f=await setup(t);let r=await f.read();assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.revision,0);validateCharterRead(r.body,'commons');
 f.send(data(0,'First instructions'));const second=f.send(data(1,'Current instructions'));
 f.store.room=()=>{throw Error('No whole-room charter read');};
 r=await f.read();assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.charter.purpose,'Current instructions');assert.equal(r.body.eventId,second.event.id);validateCharterRead(r.body,'commons');
 assert.equal((await f.read('?revision=2')).body.eventId,second.event.id);const unset=await f.read('?revision=0');assert.equal(unset.status,200);assert.equal(unset.body.charter,null);validateCharterRead(unset.body,'commons',0);
 const historical=await f.read('?revision=1');assert.equal(historical.status,409);assert.equal(historical.body.error.code,'current_room_context_unavailable');assert.equal(historical.link,'</api/rooms/commons/charter>; rel="latest"');
 assert.equal((await f.read('?revision=3')).status,404);await f.reopen();assert.equal((await f.read()).body.eventId,second.event.id);f.store.revoke(f.key);assert.equal((await f.read()).status,401);
});
