import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';
import {seedPostOAuth,postWithOAuth,providerFor,resource} from './helpers/work-linked-post-oauth.mjs';
import {readCurrentMessage} from '../server/current-room-repository.mjs';
import {createHostedRoomMcp} from '../server/mcp-room-profile.mjs';
const source=transport=>'v1:'+transport;
function fixture(t,representation){const s=new RoomStore(':memory:');s.initialize(initialRoom(),representation?{representation}:{});t.after(()=>s.close());const owner=s.issueAccessKey('commons','owner'),identity=s.identities.create('Existing provenance agent');linkWithProof(s,owner,'commons',identity,{memberId:'agent',permissions:[]});return{s,owner,identity};}
for(const representation of [undefined,'normalized-current-v1'])test('new agent source survives shared message codec and exact retry in '+(representation??'legacy'),t=>{
 const {s,owner,identity}=fixture(t,representation),command={id:'first',type:'message.posted',data:{messageId:'first',body:'A useful response'}};
 const first=s.command(identity.secret,'commons',command);assert.deepEqual(first.event.deliverySource,source('api'));
 const lease=s.transaction(()=>s.agentHeartbeats.acquireListenerLease({agentId:identity.identityId,roomId:'commons',listenerId:'caller-label-is-not-capability'}));
 const retry=s.command(identity.secret,'commons',command,null,{listenerToken:lease.fencingToken});assert.equal(retry.duplicate,true);assert.deepEqual(retry.event,first.event);
 const leased=s.command(identity.secret,'commons',{...command,id:'leased',data:{messageId:'leased',body:'Saved through a held listener'}},null,{listenerToken:lease.fencingToken});assert.deepEqual(leased.event.deliverySource,source('leased_api'));
 const message=representation?s.readTransaction(()=>readCurrentMessage(s.db,'commons','leased').value):s.room('commons').state.messages.find(m=>m.id==='leased');assert.equal(Object.hasOwn(message,'deliverySource'),false,'Event provenance never becomes message state');
 if(representation){const row=s.db.prepare("SELECT record_json,reducer_extras_json FROM messages WHERE room_id='commons' AND message_id='leased'").get();assert.equal(Object.hasOwn(JSON.parse(row.record_json),'deliverySource'),false);assert.deepEqual(JSON.parse(row.reducer_extras_json),{},'Existing edit-history-only extras codec remains unchanged');}
 const human=s.command(owner,'commons',{id:'human',type:'message.posted',data:{messageId:'human',body:'Human message'}});assert.equal(Object.hasOwn(human.event,'deliverySource'),false);
 const before=s.db.prepare("SELECT count(*) n FROM events WHERE room_id='commons'").get().n;
 assert.throws(()=>s.command(identity.secret,'commons',{...command,id:'top-spoof',deliverySource:source('oauth_connection')}),e=>e.code==='invalid_command');
 assert.throws(()=>s.command(identity.secret,'commons',{...command,id:'spoof',data:{...command.data,deliverySource:source('oauth_connection')}}),e=>e.code==='invalid_command');
 assert.throws(()=>s.command(identity.secret,'commons',{...command,id:'stale',data:{messageId:'stale',body:'Must not write'}},null,{listenerToken:'not-the-lease'}),e=>e.code==='stale_listener');
 assert.equal(s.db.prepare("SELECT count(*) n FROM events WHERE room_id='commons'").get().n,before);
});
test('real request-local OAuth classifies only verified OAuth writes and rejects MCP caller spoof',async t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());const saved=seedPostOAuth(s);
 const first=postWithOAuth(s,saved,{messageId:'oauth',body:'Verified connection result'});assert.deepEqual(first.event.deliverySource,source('oauth_connection'));
 const retry=s.command(saved.identitySecret,'commons',{id:'oauth',type:'message.posted',data:{messageId:'oauth',body:'Verified connection result'}});assert.equal(retry.duplicate,true);assert.deepEqual(retry.event,first.event);
 const mcp=createHostedRoomMcp(s,{oauthProvider:providerFor(s),oauthResource:resource});
 const good=await mcp({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'room_post_message',arguments:{id:'mcp-write',messageId:'mcp-write',body:'Actual OAuth MCP write'}}},{authorization:'Bearer '+saved.token});
 assert.equal(good.error,undefined,JSON.stringify(good));assert.equal(good.result?.isError,undefined,JSON.stringify(good));
 assert.equal(s.readTransaction(()=>readCurrentMessage(s.db,'commons','mcp-write').value.deliverySource),undefined);
 const beforeSpoof=s.db.prepare("SELECT count(*) n FROM events WHERE room_id='commons'").get().n;
 const bad=await mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'room_post_message',arguments:{body:'Spoofed',deliverySource:source('leased_api')}}},{authorization: "Bearer "+saved.token});
 assert.ok(bad.error||bad.result?.isError,JSON.stringify(bad));assert.equal(s.db.prepare("SELECT count(*) n FROM events WHERE room_id='commons'").get().n,beforeSpoof);
 assert.throws(()=>s.command(saved.token,'commons',{id:'outside',type:'message.posted',data:{messageId:'outside',body:'No ambient OAuth'}}),e=>e.code==='unauthenticated');
 const ordinary=s.command(saved.identitySecret,'commons',{id:'ordinary',type:'message.posted',data:{messageId:'ordinary',body:'API origin'}});assert.deepEqual(ordinary.event.deliverySource,source('api'));
});

for(const representation of [undefined,'normalized-current-v1'])test('channel copies and edit/delete retain first transport without exposing a DM in '+(representation??'legacy'),async t=>{
 const {s,owner,identity}=fixture(t,representation);
 s.command(owner,'commons',{id:'root',type:'message.posted',data:{messageId:'root',body:'Public root'}});
 s.command(identity.secret,'commons',{id:'reply',type:'message.posted',data:{messageId:'reply',body:'Response',replyToId:'root',alsoSendToChannel:true}});
 const read=id=>representation?s.readTransaction(()=>readCurrentMessage(s.db,'commons',id).value):s.room('commons').state.messages.find(m=>m.id===id);
 assert.equal(read('reply').deliverySource,undefined);assert.equal(read('reply:channel').deliverySource,undefined);
 s.command(identity.secret,'commons',{id:'edit',type:'message.edited',data:{messageId:'reply',body:'Updated response',expectedMessageRevision:0}});
 assert.equal(read('reply').deliverySource,undefined);
 s.command(identity.secret,'commons',{id:'delete',type:'message.deleted',data:{messageId:'reply',expectedMessageRevision:1}});
 assert.equal(read('reply').deliverySource,undefined);
 s.command(identity.secret,'commons',{id:'dm',type:'message.posted',data:{messageId:'dm',body:'Private response',toMemberId:'owner'}});
 assert.equal(read('dm').deliverySource,undefined);
 const outsider=s.identities.create('Outside DM');linkWithProof(s,owner,'commons',outsider,{memberId:'outsider',permissions:[]});
 const page=s.eventsAfter(outsider.secret,'commons',0,100);
 assert.equal(JSON.stringify(page).includes('Private response'),false);assert.equal(page.events.some(row=>row.event?.data?.messageId==='dm'),false);
});

test('signed-in human session remains unstamped and event storage failure rolls source back atomically',t=>{
 const {s,identity}=fixture(t,'normalized-current-v1');
 const account=s.bindHumanAccount('commons','owner'),slot=s.createAccountSessionSlot();const session=s.loginAccountSession(slot.token,s.issueAccountAccessKey(account.id),0);
 const human=s.command(slot.token,'commons',{id:'signed-human',type:'message.posted',data:{messageId:'signed-human',body:'Actual signed-in human'}},session.sessionBinding);
 assert.equal(Object.hasOwn(human.event,'deliverySource'),false);
 const snapshot=()=>['events','commands','messages','current_room_head','current_room_records','current_room_record_proofs'].map(table=>s.db.prepare(`SELECT * FROM ${table}`).all());const before=snapshot();
 s.db.exec("CREATE TRIGGER reject_source_event BEFORE INSERT ON events WHEN json_extract(NEW.body,'$.data.messageId')='rollback' BEGIN SELECT RAISE(ABORT,'synthetic source storage interruption'); END");
 const input={id:'rollback',type:'message.posted',data:{messageId:'rollback',body:'Must commit atomically'}};
 assert.throws(()=>s.command(identity.secret,'commons',input),/synthetic source storage interruption/);assert.deepEqual(snapshot(),before);
 s.db.exec('DROP TRIGGER reject_source_event');const first=s.command(identity.secret,'commons',input);assert.deepEqual(first.event.deliverySource,source('api'));assert.equal(s.command(identity.secret,'commons',input).duplicate,true);
});

test('whole-store export and restore retain protected provenance without a schema change',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {exportNdjsonText,replayNdjson}=await import('../server/room-export.mjs');
 const {s,identity}=fixture(t,'normalized-current-v1');s.command(identity.secret,'commons',{id:'backup',type:'message.posted',data:{messageId:'backup',body:'Retained result'}});
 const original=s.db.prepare("SELECT record_json,entity_hash FROM messages WHERE room_id='commons' AND message_id='backup'").get();
 const dir=mkdtempSync(join(tmpdir(),'source-backup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'restored.sqlite');
 replayNdjson(exportNdjsonText(s.db),file);const restored=new RoomStore(file);t.after(()=>restored.close());
 assert.deepEqual(restored.db.prepare("SELECT record_json,entity_hash FROM messages WHERE room_id='commons' AND message_id='backup'").get(),original);
 assert.equal(restored.readTransaction(()=>readCurrentMessage(restored.db,'commons','backup').value.deliverySource),undefined);
 assert.equal(JSON.parse(restored.db.prepare("SELECT body FROM events WHERE room_id='commons' AND json_extract(body,'$.data.messageId')='backup'").get().body).deliverySource,source('api'));
});
