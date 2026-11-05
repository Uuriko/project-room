// Actual Store.command/read integration contract. This is deliberately not a
// replay-sidecar adapter: synthetic creation must select the migration endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

const raw = store => JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);

test('explicit synthetic initialization selects actual normalized serving, not replay staging', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  store.initialize(initialRoom(), { representation: 'normalized-current-v1' });
  const marker = raw(store);
  assert.equal(marker.normalizedCurrent?.version, 1,
    'RED: actual initialization still persists the whole legacy room projection');
  assert.deepEqual(Object.keys(marker), ['normalizedCurrent']);
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='message_replay_units'").get(), undefined,
    'ordinary normalized initialization must not require a replay staging authority');
  const token = store.issueAccessKey('commons', 'owner');
  const legacyRead = store.room;
  store.room = () => { throw Error('unbounded full-room hydration'); };
  try {
    const command = { id: 'first-normalized-post', type: 'message.posted',
      data: { messageId: 'first', body: 'A saved ordinary task context' } };
    const first = store.command(token, 'commons', command);
    assert.equal(first.duplicate, false);
    const reply = store.command(token, 'commons', { id: 'first-normalized-reply', type: 'message.posted',
      data: { messageId: 'reply', body: 'Useful follow-through', replyToId: 'first' } });
    assert.equal(reply.sequence, first.sequence + 1);
    const savedActions=store.db.prepare('SELECT count(*) AS n FROM operator_actions').get().n;
    const retry = store.command(token, 'commons', command);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM operator_actions').get().n,savedActions,'exact retry must not mint admission/closing or transition receipts');
    assert.equal(retry.duplicate, true);
    assert.equal(retry.sequence, first.sequence);
    assert.deepEqual(raw(store).normalizedCurrent.version, 1);
  } finally { store.room = legacyRead; }
});

import { readWorkItem } from '../server/work-repository.mjs';
import { textVersion } from '../server/text-results.mjs';

test('actual normalized work lifecycle saves and reads exact result with no room hydration', t => {
  const store=new RoomStore(':memory:');t.after(()=>store.close());
  store.initialize(initialRoom(),{representation:'normalized-current-v1'});
  const token=store.issueAccessKey('commons','owner');
  store.room=()=>{throw Error('unbounded full-room hydration');};
  let serial=0;
  const send=(type,data)=>store.command(token,'commons',{id:'work-command-'+(++serial),type,data});
  send('work.proposed',{workItemId:'useful',title:'A useful task',definitionOfDone:'Exact saved result',accountableMemberId:'owner'});
  const item=()=>readWorkItem(store.db,'commons','useful');
  send('work.accepted',{workItemId:'useful',expectedRevision:item().revision});
  send('work.started',{workItemId:'useful',expectedRevision:item().revision});
  const body='A concrete useful result 🪷';
  const posted=send('message.posted',{messageId:'result',body,workItemId:'useful'});
  const completion=send('work.completed',{workItemId:'useful',expectedRevision:item().revision,evidenceKind:'room_text',
    evidenceMessageId:'result',evidenceMessageEventId:posted.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,
    producerId:'owner',summary:'Saved concrete result',nextAction:'Review'});
  assert.equal(item().state,'completed');
  const result=store.workResult(token,'commons','useful');
  assert.equal(result.result.text.body,body);
  assert.equal(result.result.receipt.eventId,completion.event.id);
  assert.equal(raw(store).normalizedCurrent.version,1);
});

import { readConversation } from '../server/conversation-sync.mjs';
test('actual conversation door selects a bounded current window before hydration',t=>{
  const store=new RoomStore(':memory:');t.after(()=>store.close());
  store.initialize(initialRoom(),{representation:'normalized-current-v1'});
  const token=store.issueAccessKey('commons','owner');store.room=()=>{throw Error('unbounded room read');};
  for(let i=0;i<12;i++)store.command(token,'commons',{id:'window-command-'+i,type:'message.posted',data:{messageId:'window-'+i,body:'Saved '+i}});
  const first=readConversation(store,token,'commons',{limit:5});
  assert.equal(first.messages.length,5);assert.equal(first.messages[0].id,'window-7');assert.ok(first.nextCursor);
  const second=readConversation(store,token,'commons',{limit:5,cursor:first.nextCursor});
  assert.equal(second.messages.length,5);assert.equal(second.messages[0].id,'window-2');
});

import { readCurrentHead, readCurrentRecord } from '../server/current-room-repository.mjs';
test('unregistered payload, proof, both-row deletion, same-count substitution and carrier writes refuse',t=>{
  const store=new RoomStore(':memory:');t.after(()=>store.close());
  store.initialize(initialRoom(),{representation:'normalized-current-v1'});
  const before=readCurrentHead(store.db,'commons');
  const mutations=[
    "UPDATE current_room_records SET payload='{}' WHERE domain='members'",
    "DELETE FROM current_room_record_proofs WHERE domain='members'",
    "DELETE FROM current_room_records WHERE domain='members'; DELETE FROM current_room_record_proofs WHERE domain='members'",
    "UPDATE current_room_records SET record_key='substituted' WHERE domain='members'",
    "UPDATE current_room_record_proofs SET record_key='substituted' WHERE domain='members'",
    "UPDATE current_room_head SET counts_json='{}'",
    "DELETE FROM current_room_head",
    "UPDATE rooms SET projection='{}' WHERE id='commons'",
    "INSERT INTO events VALUES('commons',3,'unregistered','{}')"
  ];
  for(const sql of mutations)assert.throws(()=>store.db.exec(sql),/unsupported current room writer/);
  assert.equal(readCurrentHead(store.db,'commons').head_sha256,before.head_sha256);
  assert.equal(readCurrentRecord(store.db,'commons','members','owner').id,'owner');
});
test('removing owned mutation guards cannot turn missing current membership into permissive absence',t=>{
  const store=new RoomStore(':memory:');t.after(()=>store.close());
  store.initialize(initialRoom(),{representation:'normalized-current-v1'});
  readCurrentHead(store.db,'commons'); // Populate the rowid admission cache.
  store.db.exec('DROP TRIGGER current_room_guard_current_room_records_delete');
  store.db.exec('DROP TRIGGER current_room_guard_current_room_record_proofs_delete');
  store.db.exec("DELETE FROM current_room_records WHERE domain='members'; DELETE FROM current_room_record_proofs WHERE domain='members'");
  assert.throws(()=>readCurrentRecord(store.db,'commons','members','owner'),/owned serving schema changed/);
});

import { event } from '../src/events.js';
for(const requests of [499,500])test(`complete qualified request count${requests} survives sparse command context`,t=>{
  const store=new RoomStore(':memory:');t.after(()=>store.close());
  const events=[...initialRoom(),event({id:'join-worker',roomId:'commons',actorId:'owner',type:'member.added',
    data:{memberId:'worker',displayName:'Worker',kind:'agent',permissions:[]}})];
  for(let i=0;i<requests;i++)events.push(event({id:'request-event-'+i,roomId:'commons',actorId:'owner',type:'message.posted',
    data:{messageId:'request-'+i,body:'Please help',toMemberId:'worker',requestKind:'reply',requestPolicyVersion:1}}));
  store.initialize(events,{representation:'normalized-current-v1'});
  const token=store.issueAccessKey('commons','owner');store.room=()=>{throw Error('unbounded room read');};
  const command={id:'at-capacity',type:'message.posted',data:{messageId:'new-request',body:'A new request',toMemberId:'worker',requestKind:'reply'}};
  if(requests===500)assert.throws(()=>store.command(token,'commons',command),/Reply request capacity reached/);
  else assert.equal(store.command(token,'commons',command).duplicate,false);
  assert.equal(readCurrentHead(store.db,'commons').counts.replyRequests,500);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM current_room_records WHERE room_id='commons' AND domain='replyRequests'").get().n,500);
});

import { readCurrentRoomForAudit } from '../server/current-room-repository.mjs';
import { auditRecovery } from '../server/recovery.mjs';
test('bounded current transitions equal the full shared reducer and independently recover',t=>{
  const current=new RoomStore(':memory:'),legacy=new RoomStore(':memory:');t.after(()=>{current.close();legacy.close();});
  const events=initialRoom();current.initialize(events,{representation:'normalized-current-v1'});legacy.initialize(events);
  current.now=legacy.now=()=>Date.parse('2026-11-01T20:00:00Z');
  const a=current.issueAccessKey('commons','owner'),b=legacy.issueAccessKey('commons','owner');
  const commands=[
    {id:'equal-post',type:'message.posted',data:{messageId:'root',body:'A shared basis'}},
    {id:'equal-reply',type:'message.posted',data:{messageId:'reply',body:'Follow-through',replyToId:'root',alsoSendToChannel:true}},
    {id:'equal-work',type:'work.proposed',data:{workItemId:'task',title:'Useful work',definitionOfDone:'Saved result',accountableMemberId:'owner',sourceMessageId:'root'}}
  ];
  for(const command of commands){current.command(a,'commons',command);legacy.command(b,'commons',command);}
  const actual=current.readTransaction(()=>readCurrentRoomForAudit(current,'commons'));
  assert.deepEqual(actual.state,legacy.room('commons').state);
  assert.doesNotThrow(()=>auditRecovery(current));
});

test('lost head under a closed current marker refuses before any legacy fallback',t=>{
  const store=new RoomStore(':memory:');t.after(()=>store.close());store.initialize(initialRoom(),{representation:'normalized-current-v1'});
  const token=store.issueAccessKey('commons','owner');
  store.db.exec('DROP TRIGGER current_room_guard_current_room_head_delete');
  store.db.exec("DELETE FROM current_room_head WHERE room_id='commons'");
  store.room=()=>{throw Error('legacy fallback was reached');};
  assert.throws(()=>store.command(token,'commons',{id:'lost-head',type:'message.posted',data:{messageId:'lost-head',body:'No fallback'}}),/closed current marker lacks/);
});
test('raw format permit opening and reuse of a closed admission receipt refuse',t=>{
  const store=new RoomStore(':memory:');t.after(()=>store.close());store.initialize(initialRoom(),{representation:'normalized-current-v1'});
  assert.throws(()=>store.db.prepare('UPDATE current_room_writer_permit SET enabled=1,room_id=? WHERE singleton=1').run('commons'),/unsupported current room permit/);
  const saved=store.db.prepare("SELECT id FROM operator_actions WHERE action='current_room_writer_admission' LIMIT 1").get().id;
  assert.throws(()=>store.db.prepare('UPDATE current_room_writer_permit SET enabled=1,room_id=?,receipt_id=? WHERE singleton=1').run('commons',saved),/unsupported current room permit/);
  assert.throws(()=>store.db.exec('DELETE FROM current_room_writer_permit'),/unsupported current room permit/);
});

for(const count of [1000,5000])test(`excluded history${count} keeps an honest bounded examined continuation`,t=>{
  const store=new RoomStore(':memory:');t.after(()=>store.close());
  const events=[...initialRoom(),event({id:'limit-history',roomId:'commons',actorId:'owner',type:'room.history_visibility_set',data:{historyVisibility:'since_join'}})];
  for(let i=0;i<count;i++)events.push(event({id:'hidden-event-'+i,roomId:'commons',actorId:'owner',type:'message.posted',at:'2026-01-01T00:00:00Z',data:{messageId:'hidden-'+i,body:'Before join'}}));
  events.push(event({id:'reader-joined',roomId:'commons',actorId:'owner',type:'member.added',at:'2026-02-01T00:00:00Z',data:{memberId:'reader',displayName:'Reader',kind:'agent',permissions:[]}}));
  store.initialize(events,{representation:'normalized-current-v1'});const token=store.issueAccessKey('commons','reader');
  store.room=()=>{throw Error('unbounded hydration');};
  const first=readConversation(store,token,'commons',{limit:5});
  assert.equal(first.messages.length,0);assert.ok(first.nextCursor,'an excluded window is not a complete visible-history census');
  assert.ok(first.sourceWindow.examined>0&&first.sourceWindow.examined<=64);assert.equal(first.sourceWindow.complete,false);
  const second=readConversation(store,token,'commons',{limit:5,cursor:first.nextCursor});
  assert.equal(second.messages.length,0);assert.ok(second.sourceWindow.examined>0&&second.sourceWindow.examined<=64);
  assert.throws(()=>readConversation(store,token,'commons',{messageId:'not-present'}),error=>error.code==='message_not_found');
  assert.throws(()=>readConversation(store,token,'commons',{messageId:'hidden-0'}),error=>error.code==='message_not_found');
});
