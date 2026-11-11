import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {textVersion} from '../server/text-results.mjs';
import {PAIR_POLL_INTERVAL_MS,pairProofBytes} from '../server/pairing.mjs';
import {generateKeyPair} from '../server/agent-card-signing.mjs';
import {createPrivateKey,sign} from 'node:crypto';

function fixture(t) {
 const directory=mkdtempSync(join(tmpdir(),'native-pair-')),filename=join(directory,'room.sqlite');
 let now=1800000000000,store=new RoomStore(filename,{now:()=>now});
 const owner=store.identities.create('Rowan Hale');
 new AgentRooms(store).create(owner.secret,{roomId:'native-pair',title:'Pairing',purpose:'Existing identity continuity',starter:false});
 const forbid=s=>{s.room=()=>{throw Error('pairing must not hydrate room');};};forbid(store);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 return {owner,get store(){return store;},advance(){now+=PAIR_POLL_INTERVAL_MS;},cold(){store.close();store=new RoomStore(filename,{now:()=>now});forbid(store);return store;}};
}
function durableRows(store) {
 return Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,store.db.prepare(`SELECT * FROM "${name}"`).all().map(row=>{
  if(name==='agent_identities'){const {last_used_at,last_used_ua,mcp_legacy_uses,...authority}=row;return authority;}return row;
 })]));
}

test('native pairing retains held identity, scoped grants, denied approval and exact cold poll delivery',t=>{
 const f=fixture(t),s=f.store,identity=s.identities.create('Kit Arden');
 const pending=s.pairing.start({roomId:'native-pair',displayName:'Kit Arden',holdFor:identity.identityId});
 assert.throws(()=>s.pairing.pollHeld(pending.pairId,f.owner.identityId),e=>e.status===404);
 assert.throws(()=>s.pairing.decide(identity.secret,'native-pair',{pairId:pending.pairId,decision:'approve'}),e=>e.status===403);
 const approved=s.pairing.decide(f.owner.secret,'native-pair',{pairId:pending.pairId,decision:'approve',profile:'chat'});
 assert.equal(approved.memberId,identity.identityId);assert.equal(approved.connection.identitySecret,undefined);
 const member=s.roomAuthority('native-pair',{memberId:identity.identityId}).members[identity.identityId];
 const permissions=[...member.permissions];
 assert.equal(s.authenticate(identity.secret,'native-pair').member.id,identity.identityId);
 f.advance();const first=f.cold().pairing.pollHeld(pending.pairId,identity.identityId);
 assert.equal(first.token,approved.connection.token);assert.equal(first.memberId,identity.identityId);
 f.advance();const retry=f.cold().pairing.pollHeld(pending.pairId,identity.identityId);
 assert.equal(retry.token,first.token);assert.equal(retry.identityId,identity.identityId);
 const reconnect=f.store.pairing.start({roomId:'native-pair',displayName:'Kit Arden',credential:first.token});
 assert.equal(reconnect.connection.memberId,identity.identityId);assert.equal(reconnect.reconnected,true);
 assert.deepEqual(f.store.roomAuthority('native-pair',{memberId:identity.identityId}).members[identity.identityId].permissions,permissions);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM identity_links WHERE room_id=? AND identity_id=?').get('native-pair',identity.identityId).n,1);
 assert.doesNotThrow(()=>auditRecovery(f.store));
});

test('native approval rolls identity, key and journal writes back on failed delivery save, then cold retries',t=>{
 const f=fixture(t),s=f.store;
 const pending=s.pairing.start({roomId:'native-pair',displayName:'Cleo Park'}),before=durableRows(s),prepare=s.db.prepare.bind(s.db);
 let fired=0;
 s.db.prepare=sql=>{
  const statement=prepare(sql);
  if(sql.includes("UPDATE pairs SET status='approved'"))return new Proxy(statement,{get(target,key){if(key==='run')return (...args)=>{target.run(...args);fired++;throw Error('injected delivery save');};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  return statement;
 };
 assert.throws(()=>s.pairing.decide(f.owner.secret,'native-pair',{pairId:pending.pairId,decision:'approve',profile:'review'}),/injected delivery save/);
 s.db.prepare=prepare;assert.equal(fired,1);assert.deepEqual(durableRows(s),before);
 const approved=f.cold().pairing.decide(f.owner.secret,'native-pair',{pairId:pending.pairId,decision:'approve',profile:'review'});
 f.advance();const receipt=f.cold().pairing.poll(pending.pairId,pending.deviceSecret);
 assert.equal(receipt.token,approved.connection.token);assert.equal(receipt.identitySecret,approved.connection.identitySecret);
 assert.equal(f.store.authenticate(receipt.token,'native-pair').member.id,approved.memberId);
 assert.doesNotThrow(()=>auditRecovery(f.store));
});

test('native owner merge preserves held work, canonical message privacy and side-key identity across restart',t=>{
 const f=fixture(t),s=f.store;
 const pair=(name)=>{const id=s.identities.create(name),p=s.pairing.start({roomId:'native-pair',displayName:name,holdFor:id.identityId});const approved=s.pairing.decide(f.owner.secret,'native-pair',{pairId:p.pairId,decision:'approve',profile:'contribute'});return {id,approved};};
 const kept=pair('Kit Arden'),retired=pair('Cleo Park');
 const send=(secret,type,data)=>s.command(secret,'native-pair',{id:crypto.randomUUID(),type,data});
 send(retired.id.secret,'message.posted',{messageId:'root',body:'Original author'});
 send(kept.id.secret,'message.posted',{messageId:'reply',replyToId:'root',toMemberId:retired.id.identityId,body:'Private reply'});
 send(f.owner.secret,'work.proposed',{workItemId:'held',title:'Held contract',definitionOfDone:'Saved',accountableMemberId:retired.id.identityId,verifierMemberId:kept.id.identityId,mode:'write'});
 send(retired.id.secret,'work.accepted',{workItemId:'held',expectedRevision:0});
 send(retired.id.secret,'claim.acquired',{workItemId:'held',expectedRevision:1,repository:'acme/project',ref:'main',paths:['src/**'],expiresAt:new Date(1800000060000).toISOString()});
 const before=s.db.prepare('SELECT body FROM work_entities WHERE room_id=? AND work_id=?').get('native-pair','held').body;
 const prepare=s.db.prepare.bind(s.db),snapshot=durableRows(s);let fired=0;
 s.db.prepare=sql=>{const q=prepare(sql);if(sql==='UPDATE identity_links SET member_id=? WHERE room_id=? AND member_id=?')return new Proxy(q,{get(target,key){if(key==='run')return(...args)=>{target.run(...args);fired++;throw Error('merge side save fault');};const value=target[key];return typeof value==='function'?value.bind(target):value;}});return q;};
 assert.throws(()=>s.pairing.merge(f.owner.secret,'native-pair',{keepMemberId:kept.id.identityId,retireMemberId:retired.id.identityId}),/merge side save fault/);
 s.db.prepare=prepare;assert.equal(fired,1);assert.deepEqual(durableRows(s),snapshot);
 assert.throws(()=>s.pairing.merge(retired.id.secret,'native-pair',{keepMemberId:kept.id.identityId,retireMemberId:retired.id.identityId}),e=>e.status===403);
 const result=f.cold().pairing.merge(f.owner.secret,'native-pair',{keepMemberId:kept.id.identityId,retireMemberId:retired.id.identityId});
 assert.equal(result.retired,true);
 const cold=f.cold(),authority=cold.roomAuthority('native-pair');
 assert.equal(authority.members[retired.id.identityId].active,false);
 assert.equal(authority.members[retired.id.identityId].mergedInto,kept.id.identityId);
 assert.equal(cold.authenticate(retired.id.secret,'native-pair').member.id,kept.id.identityId,'held identity follows explicit merge');
 assert.throws(()=>cold.authenticate(retired.approved.connection.token,'native-pair'),e=>e.status===403||e.status===401);
 const item=JSON.parse(cold.db.prepare('SELECT body FROM work_entities WHERE room_id=? AND work_id=?').get('native-pair','held').body),old=JSON.parse(before);
 assert.equal(item.accountableMemberId,kept.id.identityId);assert.equal(item.claim.holderId,kept.id.identityId);
 assert.equal(item.revision,old.revision);assert.equal(item.claim.expiresAt,old.claim.expiresAt);
 const rows=cold.db.prepare('SELECT message_id,author_id,to_member_id FROM messages WHERE room_id=? ORDER BY seq').all('native-pair');
 assert.equal(rows.find(x=>x.message_id==='root').author_id,kept.id.identityId);
 assert.equal(rows.find(x=>x.message_id==='reply').to_member_id,kept.id.identityId);
 assert.doesNotThrow(()=>auditRecovery(cold));
});

test('native merge refuses an over-budget complete work census before any durable writes',t=>{
 const f=fixture(t),s=f.store,ids=[];
 for(const name of ['Kit Arden','Cleo Park']){const id=s.identities.create(name),p=s.pairing.start({roomId:'native-pair',displayName:name,holdFor:id.identityId});s.pairing.decide(f.owner.secret,'native-pair',{pairId:p.pairId,decision:'approve'});ids.push(id.identityId);}
 for(let i=0;i<33;i++)s.command(f.owner.secret,'native-pair',{id:'propose-'+i,type:'work.proposed',data:{workItemId:'task-'+i,title:'Task '+i,definitionOfDone:'Saved',accountableMemberId:f.owner.identityId,mode:'read'}});
 const before=durableRows(s);
 assert.throws(()=>s.pairing.merge(f.owner.secret,'native-pair',{keepMemberId:ids[0],retireMemberId:ids[1]}),e=>e.code==='current_room_context_unavailable'&&/complete work census/.test(e.message));
 assert.deepEqual(durableRows(s),before);assert.equal(s.authenticate(f.owner.secret,'native-pair').member.id,f.owner.identityId);
 assert.doesNotThrow(()=>auditRecovery(s));
});


test('native merge refuses retained native text evidence without changing saved result or authority',t=>{
 const f=fixture(t),s=f.store;
 const ids=[];
 for(const name of ['Kit Arden','Cleo Park']){const id=s.identities.create(name),p=s.pairing.start({roomId:'native-pair',displayName:name,holdFor:id.identityId});s.pairing.decide(f.owner.secret,'native-pair',{pairId:p.pairId,decision:'approve',profile:'contribute'});ids.push(id);}
 const kept={id:ids[0]},retired={id:ids[1]};
 const send=(secret,type,data)=>s.command(secret,'native-pair',{id:crypto.randomUUID(),type,data});
 send(f.owner.secret,'work.proposed',{workItemId:'saved',title:'Saved result',definitionOfDone:'Saved',accountableMemberId:retired.id.identityId,mode:'read'});
 for(const [type,revision] of [['work.accepted',0],['work.started',1]])send(retired.id.secret,type,{workItemId:'saved',expectedRevision:revision});
 const body='Original exact saved result',posted=send(retired.id.secret,'message.posted',{messageId:'saved-text',body,workItemId:'saved'});
 send(retired.id.secret,'work.completed',{workItemId:'saved',expectedRevision:2,evidenceKind:'room_text',evidenceMessageId:'saved-text',evidenceMessageEventId:posted.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,producerId:retired.id.identityId,summary:'Saved',nextAction:'Review'});
 const receipt=JSON.parse(s.db.prepare('SELECT body FROM work_entities WHERE room_id=? AND work_id=?').get('native-pair','saved').body).receipt;
 const before=durableRows(s);
 assert.throws(()=>s.pairing.merge(f.owner.secret,'native-pair',{keepMemberId:kept.id.identityId,retireMemberId:retired.id.identityId}),e=>e.code==='current_room_context_unavailable'&&/saved native text/.test(e.message));
 assert.deepEqual(durableRows(s),before);
 const cold=f.cold();assert.equal(cold.authenticate(retired.id.secret,'native-pair').member.id,retired.id.identityId);
 assert.deepEqual(JSON.parse(cold.db.prepare('SELECT body FROM work_entities WHERE room_id=? AND work_id=?').get('native-pair','saved').body).receipt,receipt);
 assert.equal(cold.db.prepare('SELECT body FROM messages WHERE room_id=? AND message_id=?').get('native-pair','saved-text').body,body);
 assert.doesNotThrow(()=>auditRecovery(cold));
});
test('native merge refuses historical native text evidence behind a newer different-producer receipt without changing saved result or authority',t=>{
 const f=fixture(t),s=f.store;
 const ids=[];
 for(const name of ['Kit Arden','Cleo Park']){const id=s.identities.create(name),p=s.pairing.start({roomId:'native-pair',displayName:name,holdFor:id.identityId});s.pairing.decide(f.owner.secret,'native-pair',{pairId:p.pairId,decision:'approve',profile:'contribute'});ids.push(id);}
 const kept={id:ids[0]},retired={id:ids[1]};
 const send=(secret,type,data)=>s.command(secret,'native-pair',{id:crypto.randomUUID(),type,data});
 send(f.owner.secret,'work.proposed',{workItemId:'saved',title:'Saved result',definitionOfDone:'Saved',accountableMemberId:retired.id.identityId,verifierMemberId:f.owner.identityId,mode:'read'});
 for(const [type,revision] of [['work.accepted',0],['work.started',1]])send(retired.id.secret,type,{workItemId:'saved',expectedRevision:revision});
 const body='Original exact saved result',posted=send(retired.id.secret,'message.posted',{messageId:'saved-text',body,workItemId:'saved'});
 send(retired.id.secret,'work.completed',{workItemId:'saved',expectedRevision:2,evidenceKind:'room_text',evidenceMessageId:'saved-text',evidenceMessageEventId:posted.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,producerId:retired.id.identityId,summary:'Saved',nextAction:'Review'});
 const receipt=JSON.parse(s.db.prepare('SELECT body FROM work_entities WHERE room_id=? AND work_id=?').get('native-pair','saved').body).receipt;
 send(f.owner.secret,'verification.recorded',{workItemId:'saved',expectedRevision:3,result:'fail',completionEventId:receipt.eventId,evidenceVersion:receipt.evidenceVersion,summary:'Revise'});
 send(retired.id.secret,'work.started',{workItemId:'saved',expectedRevision:4,resolvedBlocker:'Revised result prepared'});
 const nextBody='New text by the unaffected owner',nextPost=send(f.owner.secret,'message.posted',{messageId:'new-saved-text',body:nextBody,workItemId:'saved'});
 send(retired.id.secret,'work.completed',{workItemId:'saved',expectedRevision:5,evidenceKind:'room_text',evidenceMessageId:'new-saved-text',evidenceMessageEventId:nextPost.event.id,evidenceVersion:textVersion(nextBody),previousCompletionEventId:receipt.eventId,producerId:f.owner.identityId,summary:'New result',nextAction:'Review'});
 const historical=JSON.parse(s.db.prepare('SELECT body FROM work_entities WHERE room_id=? AND work_id=?').get('native-pair','saved').body);
 assert.equal(historical.receipt.nativeText.messageId,'new-saved-text');assert.deepEqual(historical.receiptHistory,[receipt]);
 const before=durableRows(s);
 assert.throws(()=>s.pairing.merge(f.owner.secret,'native-pair',{keepMemberId:kept.id.identityId,retireMemberId:retired.id.identityId}),e=>e.code==='current_room_context_unavailable'&&/saved native text/.test(e.message));
 assert.deepEqual(durableRows(s),before);
 const cold=f.cold();assert.equal(cold.authenticate(retired.id.secret,'native-pair').member.id,retired.id.identityId);
 assert.deepEqual(JSON.parse(cold.db.prepare('SELECT body FROM work_entities WHERE room_id=? AND work_id=?').get('native-pair','saved').body).receiptHistory,[receipt]);
 assert.equal(cold.db.prepare('SELECT body FROM messages WHERE room_id=? AND message_id=?').get('native-pair','saved-text').body,body);
 assert.doesNotThrow(()=>auditRecovery(cold));
});



test('native proved-key reconnect preserves member and grants; inactive proof requires explicit approval',t=>{
 const f=fixture(t),s=f.store,keys=generateKeyPair(),name='Kit Arden';
 const pending=s.pairing.start({roomId:'native-pair',displayName:name,publicKey:keys.publicKey});
 const approved=s.pairing.decide(f.owner.secret,'native-pair',{pairId:pending.pairId,decision:'approve',profile:'contribute'});
 const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(keys.privateKey,'base64')]),format:'der',type:'pkcs8'});
 const keyProof=sign(null,pairProofBytes('native-pair',name,keys.publicKey),key).toString('base64');
 const before=s.roomAuthority('native-pair',{memberId:approved.memberId}).members[approved.memberId];
 const reconnect=f.cold().pairing.start({roomId:'native-pair',displayName:name,publicKey:keys.publicKey,keyProof});
 assert.equal(reconnect.connection.memberId,approved.memberId);assert.equal(reconnect.reconnected,true);
 const member=f.store.roomAuthority('native-pair',{memberId:approved.memberId}).members[approved.memberId];
 f.store.command(f.owner.secret,'native-pair',{id:'revoke',type:'member.access_changed',data:{memberId:member.id,expectedMemberRevision:member.revision,permissions:member.permissions,active:false}});
 assert.throws(()=>f.store.authenticate(reconnect.connection.token,'native-pair'),e=>e.status===403||e.status===401);
 const blocked=f.cold().pairing.start({roomId:'native-pair',displayName:name,publicKey:keys.publicKey,keyProof});
 assert.equal(blocked.connection,undefined);assert.ok(blocked.pairId);
 const restored=f.store.pairing.decide(f.owner.secret,'native-pair',{pairId:blocked.pairId,decision:'approve',profile:'chat',reconnect:true});
 assert.equal(restored.memberId,approved.memberId);
 assert.deepEqual(f.store.roomAuthority('native-pair',{memberId:member.id}).members[member.id].permissions,before.permissions,'profile must not silently replace existing grants on reconnect');
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM identity_links WHERE room_id=?').get('native-pair').n,2);
 assert.doesNotThrow(()=>auditRecovery(f.store));
});


test('native credential reconnect rolls back fresh credential when key binding fails',t=>{
 const f=fixture(t),s=f.store,id=s.identities.create('Kit Arden'),pending=s.pairing.start({roomId:'native-pair',displayName:'Kit Arden',holdFor:id.identityId});
 const approved=s.pairing.decide(f.owner.secret,'native-pair',{pairId:pending.pairId,decision:'approve'}),before=durableRows(s),keys=generateKeyPair(),prepare=s.db.prepare.bind(s.db);
 let fired=0;s.db.prepare=sql=>{const q=prepare(sql);if(!sql.includes('INSERT INTO agent_member_keys('))return q;return new Proxy(q,{get(target,key){if(key==='run')return(...args)=>{target.run(...args);fired++;throw Error('reconnect key save fault');};const value=target[key];return typeof value==='function'?value.bind(target):value;}});};
 assert.throws(()=>s.pairing.start({roomId:'native-pair',displayName:'Kit Arden',credential:approved.connection.token,publicKey:keys.publicKey}),/reconnect key save fault/);
 s.db.prepare=prepare;assert.equal(fired,1);assert.deepEqual(durableRows(s),before);
 const cold=f.cold(),reconnected=cold.pairing.start({roomId:'native-pair',displayName:'Kit Arden',credential:approved.connection.token,publicKey:keys.publicKey});
 assert.equal(reconnected.connection.memberId,id.identityId);assert.equal(cold.authenticate(approved.connection.token,'native-pair').member.id,id.identityId);
 assert.doesNotThrow(()=>auditRecovery(cold));
});
