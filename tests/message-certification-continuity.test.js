import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { prepareMessageCommand } from '../server/message-command-service.mjs';
import { readConversation } from '../server/conversation-sync.mjs';

function setup(t, enabled = true, window = null, entities = false) {
  const directory = mkdtempSync(join(tmpdir(), 'message-carrier-'));
  const file = join(directory, 'room.sqlite');
  let store = new RoomStore(file, { maintainMessageCertification: enabled, messageProjectionWindow: window, messageEntityProjection: entities });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = (type, data, id = randomUUID()) => store.command(owner, 'commons', { id, type, data });
  const certify = () => { while (!store.backfillMessages({ limit: 1000 }).done) {} store.checkMessagesParity(); };
  const certificate = () => store.db.prepare('SELECT applied_seq,parity_at_seq,state_seq FROM messages_backfill_cursor WHERE room_id=?').get('commons');
  const read = (opts = {}, token = owner) => readConversation(store, token, 'commons', opts);
  // Compare stable wire semantics against the real fallback at the SAME state.
  // Certificate mutation is rolled back, so pages retain their original domain.
  const compare = (opts = {}, token = owner) => {
    const indexed = read(opts, token); let fallback;
    try { store.transaction(() => {
      store.db.prepare('UPDATE messages_backfill_cursor SET parity_at_seq=NULL WHERE room_id=?').run('commons');
      fallback = read(opts, token); throw new Error('comparison rollback');
    }); } catch (e) { assert.equal(e.message, 'comparison rollback'); }
    for (const key of ['messages','sequence','mode','messageBytes','viewerId','addressing']) assert.deepEqual(indexed[key],fallback[key],key);
    assert.equal(Boolean(indexed.nextCursor),Boolean(fallback.nextCursor));
    return indexed;
  };
  return { get store(){return store;},owner,command,certify,certificate,read,compare,
    post:(id,body,extra={})=>command('message.posted',{messageId:id,body,...extra}),
    reopen:()=>{store.close();store=new RoomStore(file,{maintainMessageCertification:enabled,messageProjectionWindow:window,messageEntityProjection:entities});} };
}

test('certified rows survive post/edit/pin/unpin with semantic parity, duplicate receipt and reopen',t=>{
 const f=setup(t);f.post('first','first body');f.certify();const snapshotSeq=f.certificate().state_seq;
 f.post('second','second body');assert.equal(f.certificate().parity_at_seq,f.store.headSequence('commons'));f.compare({limit:1});
 const id=randomUUID();f.command('message.edited',{messageId:'first',body:'changed',expectedMessageRevision:0},id);
 f.command('message.edited',{messageId:'first',body:'changed',expectedMessageRevision:0},id);
 assert.equal(f.compare({messageId:'first'}).messages[0].body,'changed');
 for(const type of ['message.pinned','message.unpinned']){f.command(type,{messageId:'first'});assert.equal(f.certificate().parity_at_seq,f.store.headSequence('commons'));f.compare();}
 assert.equal(f.certificate().state_seq,snapshotSeq,'no full replay-state rewrite per command');
 f.reopen();assert.equal(f.certificate().parity_at_seq,f.store.headSequence('commons'));f.compare();
 // Independent full parity sweep validates every field after incremental promotion.
 assert.equal(f.store.checkMessagesParity().ok,true);
});

test('uncertified and default-off rooms never receive incremental certification',t=>{
 for(const enabled of [false,true]){const f=setup(t,enabled);f.post('uncertified','body');assert.notEqual(f.certificate()?.parity_at_seq,f.store.headSequence('commons'));f.certify();f.post('next','next');assert.equal(f.certificate().parity_at_seq===f.store.headSequence('commons'),enabled);}
});

test('failed command rolls back event, rows, receipt and certificate together',t=>{
 const f=setup(t);f.certify();const before={...f.certificate()},head=f.store.headSequence('commons');
 f.store.db.exec("CREATE TRIGGER inject_message_failure BEFORE UPDATE OF applied_seq ON messages_backfill_cursor BEGIN SELECT RAISE(ABORT,'injected certificate failure'); END");
 assert.throws(()=>f.post('failed','never visible'),/injected certificate failure/);
 assert.equal(f.store.headSequence('commons'),head);assert.deepEqual({...f.certificate()},before);
 assert.equal(f.store.db.prepare('SELECT 1 FROM messages WHERE message_id=?').get('failed'),undefined);
 f.store.db.exec('DROP TRIGGER inject_message_failure');f.compare();
});

test('deletion and unsupported transitions fall back, then replay catches up correctly',t=>{
 const f=setup(t);f.post('gone','secret');f.certify();f.post('live','current');
 const old=f.read({limit:1});f.command('message.deleted',{messageId:'gone',expectedMessageRevision:0});
 assert.notEqual(f.certificate()?.parity_at_seq,f.store.headSequence('commons'));
 assert.equal(f.read({messageId:'gone'}).messages[0].body,null);
 assert.equal(f.read({limit:1,cursor:old.nextCursor}).mode,'reset');
 f.certify();assert.equal(f.compare({messageId:'gone'}).messages[0].body,null);
 f.command('member.added',{memberId:'reader',displayName:'Reader',kind:'human',permissions:[]});
 assert.notEqual(f.certificate().parity_at_seq,f.store.headSequence('commons'));f.certify();f.compare();
});

test('normalized-tail mode removes settled history from the rewritten blob and keeps edits/replies accessible',t=>{
 const f=setup(t,true,4);f.certify();f.store.roomFlood={consume(){}};
 for(let i=0;i<30;i++)f.post(`history-${i}`,`Record ${i} completed.`);
 const state=f.store.room('commons').state;
 assert.ok(state.messages.length<=8,`tail contains ${state.messages.length}`);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE room_id=?').get('commons').n,30);
 assert.equal(f.certificate().parity_at_seq,f.store.headSequence('commons'));
 assert.equal(f.read({messageId:'history-0'}).messages[0].body,'Record 0 completed.');
 f.command('message.edited',{messageId:'history-0',body:'Corrected record.',expectedMessageRevision:0});
 assert.equal(f.read({messageId:'history-0'}).messages[0].body,'Corrected record.');
 f.post('reply-old','A follow-up.',{replyToId:'history-1'});
 assert.equal(f.read({messageId:'reply-old'}).messages[0].replyToId,'history-1');
 f.reopen();assert.equal(f.read({messageId:'history-0'}).messages[0].body,'Corrected record.');
 assert.equal(f.store.checkMessagesParity().ok,true);
 // The migration has an executable reverse path, preserving current wording.
 f.store.rehydrateAllProjections();assert.equal(f.store.room('commons').state.messagesArchive,undefined);
 assert.equal(f.store.room('commons').state.messages.find(m=>m.id==='history-0').body,'Corrected record.');
});

test('DM and channel-copy records agree after live writes; access revocation is fresh',t=>{
 const f=setup(t);f.command('member.added',{memberId:'reader',displayName:'Reader',kind:'human',permissions:[]});
 const reader=f.store.issueAccessKey('commons','reader');f.certify();f.post('root','Public root.');
 f.post('direct','Private note.',{toMemberId:'owner'});f.post('copy','Reply with public copy.',{replyToId:'root',alsoSendToChannel:true});
 const page=f.compare({},reader);assert.equal(page.messages.some(m=>m.id==='direct'),false);assert.ok(page.messages.some(m=>m.id==='copy:channel'));
 assert.equal(f.store.checkMessagesParity().ok,true);
 const member=f.store.room('commons').state.members.reader;
 f.command('member.access_changed',{memberId:'reader',expectedMemberRevision:member.revision,active:false,permissions:[]});
 assert.throws(()=>f.read({},reader),e=>e.status===401||e.status===403);
});

test('failed archived edit restores neither a record nor a new marker',t=>{
 const f=setup(t,true,2);f.certify();f.store.roomFlood={consume(){}};
 for(let i=0;i<8;i++)f.post(`old-${i}`,'Settled record.');
 const before=f.store.db.prepare('SELECT projection FROM rooms WHERE id=?').get('commons').projection;
 assert.throws(()=>f.command('message.edited',{messageId:'old-0',body:'bad revision',expectedMessageRevision:999}));
 assert.equal(f.store.db.prepare('SELECT projection FROM rooms WHERE id=?').get('commons').projection,before);
});

test('cutover preserves complete conversation pages and poll mutations without copying history back',t=>{
 const f=setup(t);f.store.roomFlood={consume(){}};
 for(let i=0;i<24;i++)f.post(`before-${i}`,'Historical record.');
 f.certify();const before=f.read({limit:100}).messages;
 f.store.messageProjectionWindow=4;
 assert.equal(f.store.archiveMessages('commons',{keepNewest:4,dryRun:false}).ok,true);
 assert.deepEqual(f.read({limit:100}).messages,before);
 f.post('poll','Choose a path.',{kind:'poll',poll:{question:'Choose a path.',options:['A','B'],allowMultiple:false}});
 f.command('poll.voted',{messageId:'poll',option:1,active:true});
 assert.equal(f.certificate().parity_at_seq,f.store.headSequence('commons'));
 assert.deepEqual(f.read({messageId:'poll'}).messages[0].pollVotes,[[],['owner']]);
 assert.equal(f.store.checkMessagesParity().ok,true);
});

test('same-head imported history never inherits the old certificate in candidate mode',t=>{
 const f=setup(t);f.post('imported','Before import.');f.certify();f.post('live','Still current.');
 const lines=[...f.store.exportEvents(f.owner,'commons')].map(line=>{
  if(line.event.type==='message.posted'&&line.event.data.messageId==='imported')line.event.data.body='Replacement history.';
  return line;
 });
 f.store.importEvents(f.owner,'commons',lines);
 assert.notEqual(f.certificate()?.parity_at_seq,f.store.headSequence('commons'));
 assert.equal(f.read({messageId:'imported'}).messages[0].body,'Replacement history.');
 f.certify();f.compare();
});

test('digest, attention and updates preserve current archived DM content across cutover and reopen', async t=>{
 const { roomAttention } = await import('../server/needs-me.mjs');
 const { projectRoomUpdates } = await import('../server/updates.mjs');
 const { messageRepository } = await import('../server/message-repository.mjs');
 const f=setup(t);f.store.roomFlood={consume(){}};
 f.command('member.added',{memberId:'reader',displayName:'Reader',kind:'human',permissions:[]});
 const reader=f.store.issueAccessKey('commons','reader');
 f.post('dm-old','Original private wording.',{toMemberId:'reader'});
 f.command('message.edited',{messageId:'dm-old',body:'Current private wording.',expectedMessageRevision:0});
 for(let i=0;i<12;i++)f.post(`tail-${i}`,'Settled public record.');
 f.certify();
 const snapshot=()=>({digest:f.store.roomDigest(reader,'commons'),attention:roomAttention(f.store,'commons','reader',null,0),updates:projectRoomUpdates(f.store,'commons','reader'),notifications:f.store.notifications.list(reader,'commons')});
 // Freeze the clock so time-derived context versions are comparable.
 const now=f.store.now();f.store.now=()=>now;
 const before=snapshot();
 assert.equal(before.attention.find(x=>x.id==='dm-old').summary,'Current private wording.');
 assert.equal(f.store.archiveMessages('commons',{keepNewest:2,dryRun:false}).ok,true);
 assert.equal(f.store.room('commons').state.messages.some(m=>m.id==='dm-old'),false);
 assert.deepEqual(snapshot(),before);
 const repo=messageRepository(f.store,'commons');
 assert.equal(repo.get('dm-old').body,'Current private wording.');
 const many=repo.getMany([...Array.from({length:520},(_,i)=>`absent-${i}`),'dm-old','tail-11','dm-old']);
 assert.deepEqual([...many.keys()].sort(),['dm-old','tail-11']);
 assert.equal(many.get('dm-old').body,'Current private wording.');
 assert.equal(repo.receivedBy('reader').filter(m=>m.id==='dm-old').length,1);
 assert.equal(repo.receivedBy('owner').some(m=>m.id==='dm-old'),false);
 f.reopen();f.store.now=()=>now;assert.deepEqual(snapshot(),before);
 // A non-message command makes certification stale; archived records remain
 // authoritative while the newly changed working set still wins.
 f.command('member.added',{memberId:'third',displayName:'Third',kind:'human',permissions:[]});
 assert.equal(roomAttention(f.store,'commons','reader',null,0).find(x=>x.id==='dm-old').summary,'Current private wording.');
 assert.equal(f.store.roomDigest(f.owner,'commons').messages.some(x=>x.id==='dm-old'),false);
});

test('repository ignores uncertified non-archived rows and refuses corrupt archive records', async t=>{
 const { messageRepository } = await import('../server/message-repository.mjs');
 const f=setup(t);f.post('original','Correct current body.');f.certify();
 f.store.db.prepare('UPDATE messages SET body=? WHERE message_id=?').run('stale table body','original');
 assert.equal(messageRepository(f.store,'commons').get('original').body,'Correct current body.');
 f.store.db.prepare('UPDATE messages SET body=? WHERE message_id=?').run('Correct current body.','original');
 f.post('tail','Settled tail.');f.certify();f.store.archiveMessages('commons',{keepNewest:1,dryRun:false});
 f.store.db.prepare('UPDATE messages SET record_json=? WHERE message_id=?').run('{invalid','original');
 assert.throws(()=>messageRepository(f.store,'commons').get('original'));
});

test('selected work discussion survives unrelated archived history without widening its scope',t=>{
 const f=setup(t);f.store.roomFlood={consume(){}};
 f.post('source','Work source.');
 f.command('work.proposed',{workItemId:'selected',title:'Selected work',definitionOfDone:'A useful answer',accountableMemberId:'owner',mode:'read',independentVerificationRequired:false,ownerDecisionRequired:true,humanDecisionMakerId:'owner',sourceMessageId:'source'});
 for(let i=0;i<12;i++)f.post(`unrelated-${i}`,'Unrelated settled text.');
 f.certify();const now=f.store.now();f.store.now=()=>now;
 const before=f.store.workDiscussion(f.owner,'commons','selected');
 const context=f.store.workContext(f.owner,'commons','selected',{includeSource:true});
 assert.equal(f.store.archiveMessages('commons',{keepNewest:2,dryRun:false}).ok,true);
 assert.equal(f.store.room('commons').state.messages.some(m=>m.id==='unrelated-0'),false);
 assert.deepEqual(f.store.workDiscussion(f.owner,'commons','selected'),before);
 assert.deepEqual(f.store.workContext(f.owner,'commons','selected',{includeSource:true}),context);
 assert.equal(JSON.stringify(before).includes('Unrelated settled text.'),false);
});

test('archived edits restore indexed reducer history without replaying unrelated events',async t=>{
 const {messageRepository}=await import('../server/message-repository.mjs');
 const f=setup(t);f.store.roomFlood={consume(){}};
 f.post('old-edit','First wording.');
 f.command('message.edited',{messageId:'old-edit',body:'Second wording.',expectedMessageRevision:0});
 const original=f.store.room('commons').state.messages.find(m=>m.id==='old-edit');
 for(let i=0;i<10;i++)f.post(`settled-${i}`,'Settled history.');
 f.certify();f.store.archiveMessages('commons',{keepNewest:2,dryRun:false});
 assert.equal(messageRepository(f.store,'commons').get('old-edit').editHistory,undefined,'reader never exposes reducer history');
 f.store.messageProjectionWindow=2;
 const replay=f.store._replayRoom;f.store._replayRoom=()=>{throw new Error('full replay forbidden');};
 f.command('message.edited',{messageId:'old-edit',body:'Third wording.',expectedMessageRevision:1});
 const current=f.store.room('commons').state.messages.find(m=>m.id==='old-edit');
 assert.deepEqual(current.editHistory.slice(0,-1),original.editHistory);
 assert.equal(current.editHistory.at(-1).body,'Second wording.');
 f.store._replayRoom=replay;
 f.command('message.deleted',{messageId:'old-edit',expectedMessageRevision:2});
 const extras=f.store.db.prepare('SELECT reducer_extras_json FROM messages WHERE room_id=? AND message_id=?').get('commons','old-edit').reducer_extras_json;
 assert.equal(String(extras).includes('wording'),false,'delete purges reducer-only historical text');
 f.reopen();assert.equal(f.store.checkMessagesParity().ok,true);
});

test('legacy archived rows without reducer extras use journal recovery and upgrade on mutation',t=>{
 const f=setup(t);f.post('legacy-entity','Old wording.');f.post('last-entity','Last.');f.certify();f.store.archiveMessages('commons',{keepNewest:1,dryRun:false});
 f.store.db.prepare('UPDATE messages SET reducer_extras_json=NULL WHERE message_id=?').run('legacy-entity');
 f.store.messageProjectionWindow=2;
 let replays=0;const replay=f.store._replayRoom.bind(f.store);f.store._replayRoom=(...args)=>{replays++;return replay(...args);};
 f.command('message.edited',{messageId:'legacy-entity',body:'Current wording.',expectedMessageRevision:0});
 assert.equal(replays,1);
 assert.equal(JSON.parse(f.store.db.prepare('SELECT reducer_extras_json FROM messages WHERE message_id=?').get('legacy-entity').reducer_extras_json).editHistory[0].body,'Old wording.');
});


test('public feed, squad channels and receipt deduplication survive archival and reopen', async t => {
 const { createSquad, getSquad } = await import('../server/squads.mjs');
 const { postReceiptCard } = await import('../server/receipt-cards.mjs');
 const f=setup(t);f.store.roomFlood={consume(){}};
 f.post('channel','Public channel.');f.post('private','Hidden private wording.',{toMemberId:'owner'});
 const item={id:'closed-item',title:'Finished task',state:'done',deliveryMode:'result',owner:'owner'};
 f.store.transaction(()=>postReceiptCard(f.store,'commons',item,Date.now()));
 for(let i=0;i<5;i++)f.post(`tail-${i}`,`Tail ${i}.`);
 const {publicCode}=f.store.publicFace.enable('commons','owner');
 const read=()=>{
   const face=f.store.publicFace.faceByCode(publicCode);
   const {fetchedAt:_at,...feed}=f.store.publicFace.feedByCode(publicCode,{limit:2});
   const {fetchedAt:_next,...next}=f.store.publicFace.feedByCode(publicCode,{after:feed.next,limit:2});
   return {messages:face.messages,feed,next};
 };
 const before=read();f.certify();f.store.archiveMessages('commons',{keepNewest:1,dryRun:false});
 assert.equal(f.store.room('commons').state.messages.some(m=>m.id==='channel'),false);
 assert.deepEqual(read(),before);
 assert.throws(()=>f.store.publicFace.feedByCode(publicCode,{after:'private'}),e=>e.code==='invalid_feed_cursor');
 const squad=createSquad(f.store,f.owner,'commons',{name:'archived-channel',goal:'Ship',memberIds:[],channelMessageId:'channel'});
 assert.equal(getSquad(f.store,f.owner,'commons',squad.squad.id).squad.channel,'channel');
 const head=f.store.headSequence('commons');
 assert.equal(f.store.transaction(()=>postReceiptCard(f.store,'commons',item,Date.now())),null);
 assert.equal(f.store.headSequence('commons'),head);
 f.reopen();assert.deepEqual(read(),before);
 assert.equal(JSON.stringify(before).includes('Hidden private wording'),false);
});


test('work and decision commands resolve archived source entities without room replay',t=>{
 const f=setup(t);f.store.roomFlood={consume(){}};
 f.post('work-source','Use this as the work brief.');f.post('decision-source','Use the pilot design.');
 f.post('private-source','Private rationale.',{toMemberId:'owner'});f.post('tail','Settled tail.');
 f.certify();f.store.archiveMessages('commons',{keepNewest:1,dryRun:false});f.store.messageProjectionWindow=2;
 const replay=f.store._replayRoom;f.store._replayRoom=()=>{throw new Error('Unrelated history replayed');};
 assert.throws(()=>f.command('decision.recorded',{sourceMessageId:'private-source',statement:'Do not publish.'}),/public room message/);
 assert.equal(f.store.room('commons').state.messages.some(m=>m.id==='private-source'),false,'refusal rolls restoration back');
 f.command('decision.recorded',{sourceMessageId:'decision-source',statement:'Use the pilot design.'});
 f.command('work.proposed',{workItemId:'from-history',title:'Build pilot',definitionOfDone:'Working pilot',accountableMemberId:'owner',verifierMemberId:'owner',humanDecisionMakerId:'owner',sourceMessageId:'work-source'});
 assert.equal(f.store.room('commons').state.workItems['from-history'].sourceMessageId,'work-source');
 f.store._replayRoom=replay;f.certify();assert.equal(f.store.checkMessagesParity().ok,true);
});


test('a deep archived reply prepares its ancestor chain without an intermediate projection write',t=>{
 const f=setup(t);f.store.roomFlood={consume(){}};
 for(let i=0;i<8;i++)f.post(`chain-${i}`,`Settled note ${i}.`,i?{replyToId:`chain-${i-1}`} : {});
 f.post('chain-tail','Unrelated tail.');f.certify();f.store.archiveMessages('commons',{keepNewest:1,dryRun:false});
 assert.equal(f.store.room('commons').state.messages.length,1);
 f.store.messageProjectionWindow=8;
 const replay=f.store._replayRoom;f.store._replayRoom=()=>{throw new Error('Unrelated history replayed');};
 const prepare=f.store.db.prepare.bind(f.store.db);let restores=0;
 f.store.db.prepare=sql=>{if(/^UPDATE rooms SET projection=\? WHERE id=\?$/.test(sql))restores++;return prepare(sql);};
 f.post('deep-reply','Continuing the thread.',{replyToId:'chain-7'});
 f.store.db.prepare=prepare;f.store._replayRoom=replay;
 assert.equal(restores,0,'command preparation must not serialize an intermediate working set');
 assert.equal(f.store.room('commons').state.messages.filter(m=>m.id.startsWith('chain-')).length,9);
 assert.equal(f.store.checkMessagesParity().ok,true);
});


test('entity projection stores references, reopens with history and preserves fallback conversation reads',t=>{
 const f=setup(t,true,4,true);f.certify();f.store.roomFlood={consume(){}};
 for(let i=0;i<7;i++)f.post(`entity-${i}`,`Content ${i}. ${'long '.repeat(100)}`);
 const raw=()=>JSON.parse(f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
 assert.ok(raw().messages.every(m=>m._entity===1 && Object.keys(m).length===2));
 f.command('message.edited',{messageId:'entity-0',body:'Revised.',expectedMessageRevision:0});
 assert.equal(f.store.room('commons').state.messages[0].editHistory.length,1);
 f.compare();f.compare({limit:2});f.reopen();
 assert.equal(f.store.room('commons').state.messages[0].body,'Revised.');
 assert.equal(f.store.room('commons').state.messages[0].editHistory.length,1);
 f.compare();assert.equal(f.store.checkMessagesParity().ok,true);
 f.store.rehydrateAllProjections();assert.equal(raw().messages.some(m=>m._entity===1),false);
 assert.equal(raw().messages[0].body,'Revised.');
});

test('entity-reference writes roll back atomically and deletion clears every history copy',t=>{
 const f=setup(t,true,4,true);f.certify();f.post('entity-private','Original secret.');
 const head=f.store.headSequence('commons');
 f.store.db.exec("CREATE TRIGGER reject_entity_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT,'entity update failed'); END");
 assert.throws(()=>f.command('message.edited',{messageId:'entity-private',body:'Failed replacement.',expectedMessageRevision:0}),/entity update failed/);
 assert.equal(f.store.headSequence('commons'),head);assert.equal(f.store.room('commons').state.messages[0].body,'Original secret.');
 f.store.db.exec('DROP TRIGGER reject_entity_update');
 f.command('message.edited',{messageId:'entity-private',body:'Replacement secret.',expectedMessageRevision:0});
 f.command('message.deleted',{messageId:'entity-private',expectedMessageRevision:1});
 f.reopen();assert.equal(f.store.room('commons').state.messages[0].body,null);
 const rows=f.store.db.prepare("SELECT body,record_json,reducer_extras_json FROM messages WHERE room_id='commons'").all();
 assert.equal(JSON.stringify(rows).includes('secret'),false);
 assert.equal(f.store.checkMessagesParity().ok,true);
});


test('entity references fail closed on missing or malformed canonical records',async t=>{
 const {hydrateProjection}=await import('../server/projection-at-rest.mjs');
 const f=setup(t,true,4,true);f.certify();f.post('guarded','Canonical text.');
 const raw=JSON.parse(f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
 const rollback=new Error('restore fixture');
 for(const sql of [
  "DELETE FROM messages WHERE message_id='guarded'",
  "UPDATE messages SET record_json='{invalid' WHERE message_id='guarded'",
  "UPDATE messages SET body='mismatch' WHERE message_id='guarded'",
  "UPDATE messages SET reducer_extras_json=NULL WHERE message_id='guarded'",
  "UPDATE messages SET reducer_extras_json='{\"unexpected\":true}' WHERE message_id='guarded'"
 ]) {
  try {f.store.transaction(()=>{
   f.store.db.exec(sql);
   assert.throws(()=>hydrateProjection(f.store.db,'commons',structuredClone(raw)),/projection_corrupt/);
   assert.throws(()=>f.store.rehydrateAllProjections(),/projection_corrupt/);
   throw rollback;
  });}catch(error){if(error!==rollback)throw error;}
 }
 assert.equal(f.store.room('commons').state.messages[0].body,'Canonical text.');
});

test('mixed legacy entities remain inline and unsupported commands safely return to inline state',async t=>{
 const {storedProjection,hydrateProjection}=await import('../server/projection-at-rest.mjs');
 const f=setup(t,true,4,true);f.certify();f.post('legacy','Retained legacy.');f.post('ready','Ready record.');
 const state=f.store.room('commons').state;
 f.store.db.prepare("UPDATE messages SET reducer_extras_json=NULL WHERE message_id='legacy'").run();
 const mixed=JSON.parse(storedProjection(f.store.db,'commons',state,{messageEntities:true}));
 assert.equal(mixed.messages[0].body,'Retained legacy.');assert.equal(mixed.messages[1]._entity,1);
 assert.deepEqual(hydrateProjection(f.store.db,'commons',mixed).state.messages,state.messages);
 // Restore the legacy row before reading the already-persisted reference.
 f.store.db.prepare("UPDATE messages SET reducer_extras_json='{}' WHERE message_id='legacy'").run();
 f.command('member.added',{memberId:'new-reader',displayName:'New reader',kind:'human',permissions:[]});
 const raw=JSON.parse(f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
 assert.equal(raw.messages.some(m=>m._entity===1),false);
 f.reopen();assert.equal(f.store.room('commons').state.messages[0].body,'Retained legacy.');
});


test('entity projections pass recovery audit and channel repair after reopening',async t=>{
 const {auditRecovery}=await import('../server/recovery.mjs');
 const f=setup(t,true,4,true);f.certify();f.post('recoverable','Recovery content.');
 f.command('message.edited',{messageId:'recoverable',body:'Revised recovery content.',expectedMessageRevision:0});
 assert.doesNotThrow(()=>auditRecovery(f.store));
 f.store.db.prepare("UPDATE rooms SET projection=json_remove(projection,'$.channels') WHERE id='commons'").run();
 f.reopen();
 assert.equal(f.store.room('commons').state.messages[0].body,'Revised recovery content.');
 assert.equal(f.store.room('commons').state.messages[0].editHistory.length,1);
 assert.doesNotThrow(()=>auditRecovery(f.store));
});


test('entity carrier consumes old body references before releasing their storage',async t=>{
 const {storedProjection,hydrateProjection}=await import('../server/projection-at-rest.mjs');
 const f=setup(t);f.store.bodiesAtRest=true;
 const body='Old body storage. '.repeat(100);f.post('body-ref',body);f.certify();
 const state=f.store.room('commons').state;
 const raw=JSON.parse(storedProjection(f.store.db,'commons',state,{enabled:true}));
 assert.equal(typeof raw.messages[0].bodyRef,'string');
 // Legacy extras force the new carrier to keep this record inline. It must
 // expand the old body reference before removing the old body-storage row.
 f.store.db.prepare("UPDATE messages SET reducer_extras_json=NULL WHERE message_id='body-ref'").run();
 const converted=JSON.parse(storedProjection(f.store.db,'commons',raw,{messageEntities:true}));
 assert.equal(converted.messages[0].body,body);
 assert.equal(converted.messages[0].bodyRef,undefined);
 assert.equal(hydrateProjection(f.store.db,'commons',converted).missing.length,0);
});


for(const archive of [false,true]) test(`resumable backfill never rewinds serving entity records (archive=${archive})`,t=>{
 const f=setup(t,true,archive?2:20,true);f.certify();f.store.roomFlood={consume(){}};
 for(let i=0;i<8;i++)f.post(`replay-${i}`,`Original ${i}.`);
 f.command('message.edited',{messageId:'replay-0',body:'Latest must remain visible.',expectedMessageRevision:0});
 const expected=f.read({limit:100}).messages;
 const serving=f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
 f.store.db.prepare("UPDATE messages_backfill_cursor SET applied_event_id='invalid-anchor',parity_at_seq=NULL WHERE room_id='commons'").run();
 let done=false;
 for(let i=0;i<50&&!done;i++) {
  done=f.store.backfillMessages({limit:1}).done;
  assert.deepEqual(f.read({limit:100}).messages,expected);
  assert.equal(f.read({messageId:'replay-0'}).messages[0].body,'Latest must remain visible.');
  assert.equal(f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection,serving);
 }
 assert.equal(done,true);assert.equal(f.store.checkMessagesParity().ok,true);
 f.reopen();assert.deepEqual(f.read({limit:100}).messages,expected);
});


test('ordinary certified writes never read or rewrite the replay snapshot',async t=>{
 const {constants}=await import('node:sqlite');
 const f=setup(t,true,4,true);f.certify();f.post('small-write','Original.');f.certify();
 const snapshot=f.store.db.prepare("SELECT state_json FROM message_replay_snapshots WHERE room_id='commons'").get().state_json;
 const access=[];
 f.store.db.setAuthorizer((operation,table)=>{
  if(table==='message_replay_snapshots')access.push(operation);
  return constants.SQLITE_OK;
 });
 try {f.command('message.edited',{messageId:'small-write',body:'Changed.',expectedMessageRevision:0});}
 finally {f.store.db.setAuthorizer(null);}
 assert.deepEqual(access,[]);
 assert.equal(f.store.db.prepare("SELECT state_json FROM message_replay_snapshots WHERE room_id='commons'").get().state_json,snapshot);
 assert.equal(f.store.db.prepare("SELECT 1 FROM pragma_table_info('messages_backfill_cursor') WHERE name='state_json'").get(),undefined);
});


test('staged replay resumes across reopen and incorporates a newer live edit',t=>{
 const f=setup(t,true,2,true);f.certify();f.store.roomFlood={consume(){}};
 for(let i=0;i<8;i++)f.post(`concurrent-${i}`,`Original ${i}.`);
 f.store.db.prepare("UPDATE messages_backfill_cursor SET applied_event_id='invalid',parity_at_seq=NULL WHERE room_id='commons'").run();
 const progress=f.store.backfillMessages({limit:3});
 assert.equal(progress.appliedSeq,0);assert.equal(progress.replaySeq,3);
 assert.equal(f.certificate().applied_seq,0);
 const staged=f.certificate().state_seq;assert.ok(staged>0);
 f.reopen();assert.equal(f.certificate().state_seq,staged);
 f.command('message.edited',{messageId:'concurrent-0',body:'New live version.',expectedMessageRevision:0});
 let done=false;
 for(let i=0;i<50&&!done;i++) {
  done=f.store.backfillMessages({limit:1}).done;
  assert.equal(f.read({messageId:'concurrent-0'}).messages[0].body,'New live version.');
 }
 assert.equal(done,true);assert.equal(f.store.checkMessagesParity().ok,true);
 f.reopen();assert.equal(f.read({messageId:'concurrent-0'}).messages[0].body,'New live version.');
});

test('failed replay publication rolls back serving rows and staging progress together',t=>{
 const f=setup(t,true,2,true);f.certify();f.store.roomFlood={consume(){}};
 for(let i=0;i<6;i++)f.post(`atomic-${i}`,`Current ${i}.`);
 f.store.db.prepare("UPDATE messages_backfill_cursor SET applied_event_id='invalid',parity_at_seq=NULL WHERE room_id='commons'").run();
 f.store.backfillMessages({limit:2});
 const cursor={...f.certificate()};
 const snapshot=f.store.db.prepare("SELECT state_json FROM message_replay_snapshots WHERE room_id='commons'").get().state_json;
 const rows=f.store.db.prepare("SELECT * FROM messages WHERE room_id='commons' ORDER BY message_id").all();
 const expected=f.read({limit:100}).messages;
 f.store.db.exec("CREATE TRIGGER reject_replay_publication BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'injected publication failure'); END");
 assert.throws(()=>f.store.backfillMessages({limit:1000}),/injected publication failure/);
 assert.deepEqual({...f.certificate()},cursor);
 assert.equal(f.store.db.prepare("SELECT state_json FROM message_replay_snapshots WHERE room_id='commons'").get().state_json,snapshot);
 assert.deepEqual(f.store.db.prepare("SELECT * FROM messages WHERE room_id='commons' ORDER BY message_id").all(),rows);
 assert.deepEqual(f.read({limit:100}).messages,expected);
 f.store.db.exec('DROP TRIGGER reject_replay_publication');
 f.certify();f.reopen();assert.deepEqual(f.read({limit:100}).messages,expected);
});


test('archive fallback pages preserve ordering and private-message filtering during replay',t=>{
 const f=setup(t,true,2,true);f.store.roomFlood={consume(){}};
 f.command('member.added',{memberId:'reader',displayName:'Reader',kind:'human',permissions:[]});
 const reader=f.store.issueAccessKey('commons','reader');f.certify();
 for(let i=0;i<12;i++)f.post(`page-${i}`,`Page ${i}.`,i%3===0?{toMemberId:'owner'}:{});
 f.command('message.edited',{messageId:'page-1',body:'Old retained edit.',expectedMessageRevision:0});
 const walk=()=>{
  const pages=[];let cursor=null;
  for(let i=0;i<20;i++) {
   const page=f.read({limit:2,...(cursor?{cursor}:{})},reader);
   assert.equal(page.mode,'replace');pages.push(...page.messages.map(m=>m.id).reverse());
   cursor=page.nextCursor;if(!cursor)return pages;
  }
  assert.fail('pagination did not terminate');
 };
 const expected=walk();assert.equal(expected.some(id=>Number(id.split('-')[1])%3===0),false);
 f.store.db.prepare("UPDATE messages_backfill_cursor SET applied_event_id='invalid',parity_at_seq=NULL WHERE room_id='commons'").run();
 f.store.backfillMessages({limit:2});assert.deepEqual(walk(),expected);
 f.certify();assert.deepEqual(walk(),expected);
});


test('deletion scrubs a staged replay snapshot and cannot resurrect on publication',t=>{
 const f=setup(t,true,2,true);f.certify();f.store.roomFlood={consume(){}};
 f.post('staged-secret','Secret staged text.');
 for(let i=0;i<8;i++)f.post(`delete-tail-${i}`,`Tail ${i}.`);
 f.store.db.prepare("UPDATE messages_backfill_cursor SET applied_event_id='invalid',parity_at_seq=NULL WHERE room_id='commons'").run();
 f.store.backfillMessages({limit:4});
 assert.ok(f.store.db.prepare("SELECT state_json FROM message_replay_snapshots WHERE room_id='commons'").get().state_json.includes('Secret staged text.'));
 f.command('message.deleted',{messageId:'staged-secret',expectedMessageRevision:0});
 assert.equal(JSON.stringify(f.store.db.prepare("SELECT state_json FROM message_replay_snapshots WHERE room_id='commons'").all()).includes('Secret staged text.'),false);
 f.reopen();f.certify();
 assert.equal(f.read({messageId:'staged-secret'}).messages[0].body,null);
 assert.equal(f.store.checkMessagesParity().ok,true);
});


test('archive conversation filters private bodies before decoding them',t=>{
 const f=setup(t,true,2,true);f.store.roomFlood={consume(){}};
 f.command('member.added',{memberId:'reader',displayName:'Reader',kind:'human',permissions:[]});
 const reader=f.store.issueAccessKey('commons','reader');f.certify();
 f.post('hidden-archive','Private.',{toMemberId:'owner'});
 for(let i=0;i<8;i++)f.post(`visible-${i}`,`Public ${i}.`);
 f.store.db.prepare("UPDATE messages_backfill_cursor SET parity_at_seq=NULL WHERE room_id='commons'").run();
 f.store.db.prepare("UPDATE messages SET record_json='{invalid' WHERE message_id='hidden-archive'").run();
 assert.equal(f.read({limit:100},reader).messages.length,8);
 assert.throws(()=>f.read({limit:100}),SyntaxError);
});


test('archive fallback applies same-instant history exclusions before the page limit',t=>{
 const f=setup(t,true,2,true);f.store.roomFlood={consume(){}};
 const at=Date.now();f.store.now=()=>at+1000;
 f.post('future-visible','Visible by timestamp policy.');
 f.store.now=()=>at;
 for(let i=0;i<6;i++)f.post(`before-join-${i}`,'Before join.');
 f.command('room.history_visibility_set',{historyVisibility:'since_join'});
 f.command('member.added',{memberId:'late',displayName:'Late',kind:'human',permissions:[]});
 const late=f.store.issueAccessKey('commons','late');
 f.post('after-join','After join.');f.certify();
 f.store.archiveMessages('commons',{keepNewest:2,dryRun:false});
 const expected=f.read({limit:2},late);
 assert.deepEqual(expected.messages.map(m=>m.id),['future-visible','after-join']);
 f.store.db.prepare("UPDATE messages_backfill_cursor SET parity_at_seq=NULL WHERE room_id='commons'").run();
 const page=f.read({limit:2},late);
 assert.deepEqual(page.messages,expected.messages);assert.equal(page.nextCursor,null);
 assert.throws(()=>f.read({messageId:'before-join-0'},late),error=>error.status===404);
});


test('archived command preparation is ephemeral and leaves the serving projection unchanged',t=>{
 const f=setup(t); f.store.roomFlood={consume(){}};
 f.post('context-old','Original intent.'); f.post('context-tail','Other work.'); f.certify();
 f.store.archiveMessages('commons',{keepNewest:1,dryRun:false}); f.store.messageProjectionWindow=2;
 const room=f.store.room('commons');
 const before=f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
 f.store.transaction(()=>{
  const context=prepareMessageCommand(f.store,'commons',room,{type:'message.edited',data:{messageId:'context-old'}},'owner');
  assert.equal(context.state.messages.find(m=>m.id==='context-old').body,'Original intent.');
  assert.equal(room.state.messages.some(m=>m.id==='context-old'),false,'input context is immutable');
  assert.equal(f.store.room('commons').state.messages.some(m=>m.id==='context-old'),false,'readers keep the committed working set');
  assert.equal(f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection,before);
 });
});
