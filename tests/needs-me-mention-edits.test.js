// r211 (John's Tab QA): a mention edited or deleted after posting. #2941 made
// needs-me room DMs follow the live projection (deleted DMs absent, edited DMs
// show the current body). Mentions come from store.openDirectMentions, which
// still reads the body logged at post time, so room_needs_me and the agent
// inbox list a deleted mention (blank summary, a room_reply next step aimed at
// a tombstone) and keep the pre-edit text of an edited one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe } from '../server/needs-me.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

function seeded(t) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create('OwnerMx');
  const ada = store.identities.create('Ada');
  const roomId = 'mention-current-state';
  rooms.create(owner.secret, { roomId, title: 'mx', purpose: 'x', kind: 'personal' });
  linkWithProof(store, owner.secret, roomId, ada, { displayName: 'Ada', permissions: [] });
  const post = (id, body) => store.command(owner.secret, roomId, { id, type: 'message.posted', data: { messageId: id, body } });
  post('m-live', '@Ada live mention');
  post('m-edited', '@Ada PRE-EDIT deploy to prod');
  post('m-deleted', '@Ada DELETED pasted token');
  store.command(owner.secret, roomId, { id: 'edit-1', type: 'message.edited', data: { messageId: 'm-edited', expectedMessageRevision: 0, body: '@Ada do NOT deploy' } });
  store.command(owner.secret, roomId, { id: 'delete-1', type: 'message.deleted', data: { messageId: 'm-deleted', expectedMessageRevision: 0 } });
  return { store, owner, ada, roomId };
}

test('needs-me mentions honour deletions and edits', t => {
  const { store, ada } = seeded(t);
  const mentions = collectNeedsMe(store, ada.secret, {}).items.filter(i => i.kind === 'mention');
  assert.deepEqual(mentions.map(i => i.id).sort(), ['m-edited', 'm-live'], 'deleted mention must not surface as an attention item');
  assert.equal(mentions.find(i => i.id === 'm-edited').summary, '@Ada do NOT deploy', 'edited mention must show its current body, not the pre-edit text');
  assert.equal(mentions.find(i => i.id === 'm-live').summary, '@Ada live mention');
});

test('openDirectMentions (agent inbox source) honours deletions and edits', t => {
  const { store, ada, roomId } = seeded(t);
  const memberId = store.authenticate(ada.secret, roomId).member.id;
  const rows = store.openDirectMentions(roomId, memberId, 50);
  assert.deepEqual(rows.map(r => r.messageId).sort(), ['m-edited', 'm-live']);
  assert.equal(rows.find(r => r.messageId === 'm-edited').body, '@Ada do NOT deploy');
});

// r213 (John's Tab, 13063): the refill loop paged the wrong way. The query
// orders sequence DESC, so advancing the cursor to the batch's lowest
// sequence re-read the newest rows: once a deleted mention forced a refill,
// the list repeated items and dropped older ones. Agents set this limit
// (1..200) via room_inbox and agent-inbox, so they hit it.
function paged(t) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create('OwnerMx');
  const ada = store.identities.create('Ada');
  const roomId = 'mention-paging';
  rooms.create(owner.secret, { roomId, title: 'mx', purpose: 'x', kind: 'personal' });
  linkWithProof(store, owner.secret, roomId, ada, { displayName: 'Ada', permissions: [] });
  const post = (id, body) => store.command(owner.secret, roomId, { id, type: 'message.posted', data: { messageId: id, body } });
  const del = (id) => store.command(owner.secret, roomId, { id: 'del-' + id, type: 'message.deleted', data: { messageId: id, expectedMessageRevision: 0 } });
  for (const id of ['m10', 'm20', 'm30', 'm40', 'm50']) post(id, `@Ada mention ${id}`);
  return { store, ada, roomId, del };
}

test('openDirectMentions paging stays distinct when a deletion forces a refill', t => {
  const { store, ada, roomId, del } = paged(t);
  const memberId = store.authenticate(ada.secret, roomId).member.id;
  del('m50');
  del('m20');
  const rows = store.openDirectMentions(roomId, memberId, 3);
  assert.deepEqual(rows.map(r => r.messageId), ['m40', 'm30', 'm10'], 'refill must page older rows, not repeat the newest batch');
});

test('openDirectMentions keeps the oldest mention when top deletions force multiple refills', t => {
  const { store, ada, roomId, del } = paged(t);
  const memberId = store.authenticate(ada.secret, roomId).member.id;
  del('m50');
  del('m40');
  const rows = store.openDirectMentions(roomId, memberId, 3);
  assert.deepEqual(rows.map(r => r.messageId), ['m30', 'm20', 'm10']);
});

import {canonicalNeedsMeRoom,drainCanonicalNeedsMe} from './helpers/canonical-needs-me-room.mjs';
import {readCurrentMessage,withCurrentRoomWriter} from '../server/current-room-repository.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
test('canonical edits preserve opening delivery obligations without creating new wakes',t=>{
 const f=canonicalNeedsMeRoom(t),{store,owner,worker,other,roomId}=f;
 f.send(owner,'message.posted',{messageId:'original-mention',body:'@Canonical worker Original request'});
 f.send(owner,'message.posted',{messageId:'plain',body:'Plain message'});
 const before=store.db.prepare('SELECT * FROM mention_states WHERE room_id=? ORDER BY message_event_id,mentioned_member_id').all(roomId),wakes=store.agentHeartbeats.pendingWakes(worker.identityId,{limit:50});
 f.send(owner,'message.edited',{messageId:'original-mention',expectedMessageRevision:0,body:'Latest body without the handle'});
 f.send(owner,'message.edited',{messageId:'plain',expectedMessageRevision:0,body:'@Canonical worker An edit is not a new delivery'});
 assert.deepEqual(store.db.prepare('SELECT * FROM mention_states WHERE room_id=? ORDER BY message_event_id,mentioned_member_id').all(roomId),before);
 assert.deepEqual(store.agentHeartbeats.pendingWakes(worker.identityId,{limit:50}),wakes);
 const mentions=drainCanonicalNeedsMe(store,worker).items.filter(x=>x.kind==='mention');assert.deepEqual(mentions.map(x=>x.id),['original-mention']);assert.equal(mentions[0].summary,'Latest body without the handle');
 f.send(owner,'message.posted',{messageId:'private-edit',body:'Private original',toMemberId:other.identityId});f.send(owner,'message.edited',{messageId:'private-edit',expectedMessageRevision:0,body:'@Canonical worker PRIVATE_EDIT_SENTINEL'});
 assert.doesNotMatch(JSON.stringify(drainCanonicalNeedsMe(store,worker)),/PRIVATE_EDIT_SENTINEL/);assert.equal(store.openDirectMentions(roomId,worker.identityId).some(x=>x.messageId==='private-edit'),false);
});
test('canonical editing refuses stale or foreign changes and preserves immutable native result text',t=>{
 const f=canonicalNeedsMeRoom(t),{store,owner,worker,other,roomId}=f;
 f.send(owner,'message.posted',{messageId:'editable',body:'Original'});const prior=store.headSequence(roomId);
 assert.throws(()=>f.send(other,'message.edited',{messageId:'editable',expectedMessageRevision:0,body:'Foreign'}),e=>e.status===403||e.status===422);
 assert.throws(()=>f.send(owner,'message.edited',{messageId:'editable',expectedMessageRevision:1,body:'Stale'}),e=>e.status===409||e.status===422);assert.equal(store.headSequence(roomId),prior);
 f.propose('immutable');f.send(worker,'work.accepted',{workItemId:'immutable',expectedRevision:0});f.finish('immutable');
 assert.throws(()=>f.send(worker,'message.edited',{messageId:'result-immutable',expectedMessageRevision:0,body:'Forged replacement'}),/recorded result.*cannot be changed/);
 assert.equal(readCurrentMessage(store.db,roomId,'result-immutable').value.body,'Saved useful result immutable');assert.doesNotThrow(()=>auditRecovery(store));
});
test('canonical edit save fault rolls back carrier, body, command and witness then permits exact retry',t=>{
 const f=canonicalNeedsMeRoom(t),{store,owner,roomId}=f;f.send(owner,'message.posted',{messageId:'edit-fault',body:'Original'});
 const sequence=store.headSequence(roomId),prepare=store.db.prepare.bind(store.db),command={id:'saved-edit-retry',type:'message.edited',data:{messageId:'edit-fault',expectedMessageRevision:0,body:'Saved after retry'}};
 store.db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('UPDATE rooms SET sequence=?,projection=?,archived_at=?'))return{run(...args){statement.run(...args);throw Error('Injected edit carrier save fault');}};return statement;};
 assert.throws(()=>store.command(owner.secret,roomId,command),/Injected edit carrier save fault/);store.db.prepare=prepare;
 assert.equal(store.headSequence(roomId),sequence);assert.equal(readCurrentMessage(store.db,roomId,'edit-fault').value.body,'Original');
 const saved=store.command(owner.secret,roomId,command);assert.equal(saved.duplicate,false);assert.equal(store.command(owner.secret,roomId,command).duplicate,true);assert.equal(readCurrentMessage(store.db,roomId,'edit-fault').value.body,'Saved after retry');assert.doesNotThrow(()=>auditRecovery(store));
});
test('normalized direct mention array refuses incomplete source instead of silently losing older obligations',t=>{
 const f=canonicalNeedsMeRoom(t),{store,owner,worker,roomId}=f;f.send(owner,'message.posted',{messageId:'older-ask',body:'@Canonical worker Older outstanding ask'});
 for(let i=0;i<10;i++)f.send(owner,'message.posted',{messageId:'ordinary-'+i,body:'Unrelated visible conversation '+i});
 assert.throws(()=>store.openDirectMentions(roomId,worker.identityId,50),e=>e.code==='current_room_context_unavailable');
 assert.ok(drainCanonicalNeedsMe(store,worker).items.some(x=>x.kind==='mention'&&x.id==='older-ask'),'the supported inbox continuation recovers the old obligation');
});
test('normalized edited pre-join mention stays hidden at the exact activation floor',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();
 const add=(type,data,at)=>events.push(event({roomId:'commons',actorId:'owner',type,data,at}));
 add('member.added',{memberId:'worker',displayName:'Worker',kind:'agent',permissions:[]},'2026-01-01T00:00:00Z');
 add('room.history_visibility_set',{historyVisibility:'since_join'},'2026-01-01T01:00:00Z');
 add('message.posted',{messageId:'before-reactivation',body:'@Worker Hidden old body'},'2026-01-02T00:00:00Z');
 add('member.access_changed',{memberId:'worker',active:false,permissions:[],expectedMemberRevision:0},'2026-01-03T00:00:00Z');
 add('member.access_changed',{memberId:'worker',active:true,permissions:[],expectedMemberRevision:1},'2026-01-04T00:00:00Z');
 store.initialize(events,{representation:'normalized-current-v1'});const key=store.issueAccessKey('commons','owner'),worker=store.issueAccessKey('commons','worker');
 store.command(key,'commons',{id:'edit-hidden',type:'message.edited',data:{messageId:'before-reactivation',expectedMessageRevision:0,body:'@Worker EDITED_PREJOIN_SENTINEL'}});
 assert.deepEqual(store.openDirectMentions('commons','worker'),[]);assert.doesNotMatch(JSON.stringify(store.agentInbox(worker,'commons')),/EDITED_PREJOIN_SENTINEL/);
});
test('normalized mention array never treats a filtered empty source window as complete',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();
 const add=(type,data,at)=>events.push(event({roomId:'commons',actorId:'owner',type,data,at}));
 add('member.added',{memberId:'worker',displayName:'Worker',kind:'agent',permissions:[]},'2026-01-01T00:00:00Z');
 add('room.history_visibility_set',{historyVisibility:'since_join'},'2026-01-01T01:00:00Z');
 add('member.access_changed',{memberId:'worker',active:false,permissions:[],expectedMemberRevision:0},'2026-01-03T00:00:00Z');
 add('member.access_changed',{memberId:'worker',active:true,permissions:[],expectedMemberRevision:1},'2026-01-04T00:00:00Z');
 add('message.posted',{messageId:'visible-below-filtered-window',body:'@Worker Still owed'},'2026-01-05T00:00:00Z');
 for(let i=0;i<64;i++)add('message.posted',{messageId:'later-backdated-'+i,body:'Hidden by the activation time'},'2026-01-02T00:00:00Z');
 store.initialize(events,{representation:'normalized-current-v1'});
 assert.throws(()=>store.openDirectMentions('commons','worker'),e=>e.code==='current_room_context_unavailable','empty filtered source must retain honest continuation/refusal');
});

test('normalized mention arrays refuse malformed or oversized opening rows before returning delivery',t=>{
 for(const mode of ['actor','id','oversized']){
  const f=canonicalNeedsMeRoom(t),{store,owner,worker,roomId}=f;const posted=f.send(owner,'message.posted',{messageId:'bad-opening',body:'@Canonical worker Original'});
  const raw=store.db.prepare('SELECT body FROM events WHERE room_id=? AND id=?').get(roomId,posted.event.id),bad=JSON.parse(raw.body);
  if(mode==='actor')bad.actorId='unrelated';else if(mode==='id')bad.id='substituted';else bad.data.body='X'.repeat(140000);
  store.transaction(()=>withCurrentRoomWriter(store.db,roomId,()=>store.db.prepare('UPDATE events SET body=? WHERE room_id=? AND id=?').run(JSON.stringify(bad),roomId,posted.event.id)));
  assert.throws(()=>store.openDirectMentions(roomId,worker.identityId),e=>e.code==='current_room_context_unavailable',mode);
 }
});
