import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
function fixture(t,mode){
 const entity=['entity','archive','mixed'].includes(mode), archived=mode.startsWith('archive');
 const options={bodiesAtRest:mode==='body-ref',...(entity?{messageProjectionWindow:archived?4:100,messageEntityProjection:true}:{})};
 let now=Date.now();const store=new RoomStore(':memory:',{...options,now:()=>now});t.after(()=>store.close());store.initialize(initialRoom());const owner=store.issueAccessKey('commons','owner');
 const command=(type,data)=>{now+=2000;return store.command(owner,'commons',{id:crypto.randomUUID(),type,data});};
 command('member.added',{memberId:'reader',displayName:'Reader',kind:'human',permissions:[]});const reader=store.issueAccessKey('commons','reader');
 store.dmConsents.request('commons','owner','reader','Test');store.dmConsents.decide('commons','reader','owner','approve');
 for(let i=0;i<12;i++)command('message.posted',{messageId:`unrelated-${i}`,body:'unrelated-sentinel-'+i+'x'.repeat(2000)});
 command('message.posted',{messageId:'ask',body:'Selected question',toMemberId:'reader',requestKind:'reply'});
 if(entity){while(!store.backfillMessages({limit:1000}).done){}assert.equal(store.checkMessagesParity().ok,true);command('message.posted',{messageId:'tail',body:'Unrelated tail'});assert.ok(JSON.parse(store.db.prepare('SELECT projection FROM rooms WHERE id=?').get('commons').projection).messages.some(m=>m._entity===1));}
 if(archived){const state=JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);assert.ok(state.messagesArchive);assert.equal(state.messages.some(m=>m.id==='unrelated-0'),false);assert.ok(state.messages.some(m=>m.id==='ask'), 'request roots are deliberately retained by archive policy');}
 if(mode==='mixed'){const state=JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);state.messages[0]=store.room('commons').state.messages[0];assert.ok(state.messages.some(m=>m._entity===1));assert.ok(state.messages.some(m=>!m._entity));store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(state));}
 store._dropProjectionCache();return {store,reader,read:()=>store.replyRequests.selected(reader,'commons','ask',{limit:1})};
}
for(const mode of ['inline','body-ref','entity','archive','mixed'])test(`selected and history reply reads avoid full hydration (${mode})`,t=>{
 const {store,reader,read}=fixture(t,mode);const guard=t.mock.method(store,'room',()=>{throw Error('full conversation hydration');});
 const prepare=store.db.prepare.bind(store.db);const returned=[];
 t.mock.method(store.db,'prepare',sql=>new Proxy(prepare(sql),{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return(...args)=>{const result=value.apply(target,args);if(['get','all'].includes(key))returned.push(JSON.stringify(result));return result;};}}));
 assert.equal(read().page.items[0].message.body,'Selected question');assert.ok(read().current.answerBasis);
 assert.equal(store.replyRequests.history(reader,'commons').page.items[0].message.body,'Selected question');
 assert.equal(guard.mock.callCount(),0);assert.equal(returned.some(s=>s?.includes('unrelated-sentinel-')),false);
});
for(const corruption of ['body','missing','extras','id','reference'])test(`metadata reply read refuses unrelated entity ${corruption} corruption`,t=>{
 const {store,read}=fixture(t,'entity');
 if(corruption==='body')store.db.prepare("UPDATE messages SET body='tampered' WHERE room_id='commons' AND message_id='unrelated-0'").run();
 if(corruption==='missing')store.db.prepare("DELETE FROM messages WHERE room_id='commons' AND message_id='unrelated-0'").run();
 if(corruption==='extras')store.db.prepare("UPDATE messages SET reducer_extras_json='[]' WHERE room_id='commons' AND message_id='unrelated-0'").run();
 if(corruption==='id')store.db.prepare("UPDATE messages SET record_json=json_set(record_json,'$.id','wrong') WHERE room_id='commons' AND message_id='unrelated-0'").run();
 if(corruption==='reference'){const row=store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get();const state=JSON.parse(row.projection);state.messages.find(m=>m.id==='unrelated-0').unexpected=true;store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(state));}
 store._dropProjectionCache();assert.throws(read,/projection_corrupt|Invalid archived|reply_history_changed/);
});
test('missing unrelated body reference still recovers from canonical events',t=>{
 const {store,read}=fixture(t,'body-ref');store.db.prepare("DELETE FROM projection_bodies WHERE room_id='commons'").run();store._dropProjectionCache();const replay=t.mock.method(store,'_restoreBodiesFromLog',store._restoreBodiesFromLog.bind(store));assert.equal(read().page.items[0].message.body,'Selected question');assert.equal(replay.mock.callCount(),1);
});
for(const mutation of ['malformed-record','malformed-extras','edit-history-null'])test(`metadata reader rejects ${mutation}`,t=>{
 const {store,read}=fixture(t,'entity');
 const field=mutation==='malformed-record'?'record_json':'reducer_extras_json';
 store.db.prepare(`UPDATE messages SET ${field}=? WHERE room_id='commons' AND message_id='unrelated-0'`).run(mutation==='edit-history-null'?' {"editHistory":null}':'{broken');store._dropProjectionCache();assert.throws(read);
});
test('selected tampered body reference recovers without returning tampered text',t=>{
 const {store,reader}=fixture(t,'body-ref');const owner=store.issueAccessKey('commons','owner');store.command(owner,'commons',{id:'long-ask',type:'message.posted',data:{messageId:'long-question',body:'Selected long question '+'q'.repeat(400),toMemberId:'reader',requestKind:'reply'}});
 const state=JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);const sha=state.messages.find(m=>m.id==='long-question').bodyRef;assert.equal(typeof sha,'string');store.db.prepare("UPDATE projection_bodies SET body='tampered' WHERE room_id='commons' AND sha=?").run(sha);store._dropProjectionCache();
 assert.equal(store.replyRequests.selected(reader,'commons','long-question').page.items[0].message.body,'Selected long question '+'q'.repeat(400));
});
test('unrecoverable unrelated missing body still refuses selected reply context',t=>{
 const {store,read}=fixture(t,'body-ref');store.db.prepare("DELETE FROM projection_bodies WHERE room_id='commons'").run();store._dropProjectionCache();t.mock.method(store,'_replayRoom',()=>({state:{messages:[]}}));assert.throws(read,/could not be restored/);
});
for(const body of [true,1])test(`metadata validation does not coerce entity body ${JSON.stringify(body)} to text`,t=>{
 const {store,read}=fixture(t,'entity');store.db.prepare("UPDATE messages SET record_json=json_set(record_json,'$.body',json(?)),body='1' WHERE room_id='commons' AND message_id='unrelated-0'").run(JSON.stringify(body));store._dropProjectionCache();assert.throws(read,/projection_corrupt/);
});
test('unrelated canonical work corruption still refuses reply preparation',t=>{
 const {store,read}=fixture(t,'inline'),owner=store.issueAccessKey('commons','owner');store.command(owner,'commons',{id:'work',type:'work.proposed',data:{workItemId:'unrelated-work',title:'Other work',definitionOfDone:'Keep canonical validation',mode:'read',accountableMemberId:'owner'}});store.migrateWorkProjections();assert.equal(store.db.prepare("SELECT count(*) AS n FROM work_entities WHERE room_id='commons'").get().n,1);store.db.prepare("UPDATE work_entities SET body='{}' WHERE room_id='commons'").run();store._dropProjectionCache();assert.throws(read,/work_projection_corrupt/);
});
