import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {auditRecovery} from '../server/recovery.mjs';
import {readCurrentRoomForAudit} from '../server/current-room-repository.mjs';

function fixture(t,channels=0){
 const store=new RoomStore(':memory:');t.after(()=>store.close());
 const events=initialRoom();
 events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'peer',displayName:'Peer',kind:'human',permissions:[]}}));
 for(let i=0;i<channels;i++)events.push(event({roomId:'commons',actorId:'owner',type:'channel.created',data:{channelId:'extra-'+i,name:'extra-'+i}}));
 store.initialize(events,{representation:'normalized-current-v1'});
 const keys={owner:store.issueAccessKey('commons','owner'),peer:store.issueAccessKey('commons','peer')};
 store.room=()=>{throw Error('Whole room read forbidden');};
 const send=(id,type,data,actor='owner')=>store.command(keys[actor],'commons',{id,type,data});
 const snapshot=()=>JSON.stringify(store.readTransaction(()=>readCurrentRoomForAudit(store,'commons')));
 return{store,send,snapshot};
}
test('native channel creation retains complete catalog uniqueness and capacity',t=>{
 const {store,send,snapshot}=fixture(t,48);
 send('last','channel.created',{channelId:'last',name:'Last'});
 const before=snapshot();
 assert.throws(()=>send('over','channel.created',{channelId:'over',name:'Over'}),/Channel limit/);
 assert.equal(snapshot(),before);
 assert.equal(send('last','channel.created',{channelId:'last',name:'Last'}).duplicate,true);
 assert.doesNotThrow(()=>auditRecovery(store));
 const other=fixture(t,2),prior=other.snapshot();
 assert.throws(()=>other.send('duplicate-name','channel.created',{channelId:'different',name:'extra-0'}),/name is taken/);
 assert.equal(other.snapshot(),prior);
});
test('native task visibility preserves owner permission and rolls back interrupted saves',t=>{
 const {store,send,snapshot}=fixture(t);
 send('task','work.proposed',{workItemId:'task',title:'Template task',definitionOfDone:'Saved result',mode:'read',accountableMemberId:'owner'});
 const before=snapshot();
 assert.throws(()=>send('denied','work.public_set',{workItemId:'task',enabled:true},'peer'),/owner or the proposer/);
 assert.equal(snapshot(),before);
 const prepare=store.db.prepare.bind(store.db);
 store.db.prepare=sql=>{const stmt=prepare(sql);if(sql.startsWith('UPDATE rooms SET sequence='))stmt.run=()=>{throw Error('Interrupted task save');};return stmt;};
 assert.throws(()=>send('publish','work.public_set',{workItemId:'task',enabled:true}),/Interrupted task save/);
 store.db.prepare=prepare;
 assert.equal(snapshot(),before);
 send('publish','work.public_set',{workItemId:'task',enabled:true});
 assert.equal(send('publish','work.public_set',{workItemId:'task',enabled:true}).duplicate,true);
 assert.doesNotThrow(()=>auditRecovery(store));
});
