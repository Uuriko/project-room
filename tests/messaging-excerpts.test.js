import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {rmSync} from 'node:fs';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {prepareInboxResult} from '../scripts/inbox-result-fixture.mjs';

for(const provider of ['telegram','sms','whatsapp'])test(`${provider} shares exact selected text with room or selected agents, never other source fields`,t=>{
  const f=createAcceptanceFixture();t.after(()=>{f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const account=f.store.accountForMember('commons','owner'),slot=f.store.createAccountSessionSlot();
  const auth=f.store.loginAccountSession(slot.token,f.store.issueAccountAccessKey(account.id),0);
  const apply=r=>f.store.inbox.apply(slot.token,r,auth.sessionBinding),prefix=provider==='whatsapp'?'whatsapp:':'';
  const data={adapter:'message',provider,accountId:account.id,connectionId:'one',conversationId:'44',providerMessageId:'9',providerRevision:'0',
    sender:provider==='telegram'?'44':prefix+'+14155550101',recipient:provider==='telegram'?'Inbox':prefix+'+14155550100',subject:'Unshared subject',paragraphs:['Keep 🪷 this\nPRIVATE remainder']};
  if(provider!=='telegram')Object.assign(data,{providerAccountId:'AC'+'a'.repeat(32),providerMessageId:'SM'+'b'.repeat(32),conversationId:JSON.stringify([data.sender,data.recipient])});
  const sourceId=(provider==='telegram'?'tg-':'tw-')+createHash('sha256').update(JSON.stringify(provider==='telegram'?[account.id,'one',44,9]:[account.id,'one',data.providerAccountId,data.providerMessageId])).digest('hex');
  f.store.transaction(()=>f.store.inbox.importMessage(slot.token,{action:'message.import',requestId:randomUUID(),sourceId,expectedRevision:0,data},auth.sessionBinding));
  const request=()=>({action:'source.excerpt',requestId:randomUUID(),sourceId,sourceRevision:1,roomId:'commons',
    audienceVersion:f.store.inbox.shareContext(slot.token,sourceId,'commons',auth.sessionBinding).audienceVersion,selection:{start:0,end:'Keep 🪷 this'.length}});
  const before=auditRecovery(f.store);
  for(const selection of [{start:0,end:9999},{start:5,end:6},{start:6,end:7},{start:0,end:0},{start:0,end:4,body:'injected'}])
    assert.throws(()=>apply({...request(),selection}),{code:'invalid_inbox_share'});
  assert.throws(()=>apply({...request(),audienceVersion:'0'.repeat(64)}),{code:'stale_inbox_audience'});
  assert.throws(()=>apply({...request(),sourceRevision:2}),{code:'stale_inbox_source'});
  assert.throws(()=>f.store.inbox.apply(f.keys.producer,request(),auth.sessionBinding),{status:401});
  assert.deepEqual(auditRecovery(f.store),before);
  const r=request(),receipt=apply(r),message=f.store.room('commons').state.messages.find(m=>m.id===receipt.receipt.messageId);
  assert.equal(message.body,'Shared message excerpt\n\nKeep 🪷 this');assert.ok(!JSON.stringify(message).includes('PRIVATE'));
  assert.ok(!JSON.stringify(message).includes(data.subject));assert.ok(!message.body.includes(data.sender));
  assert.equal(apply(r).duplicate,true);assert.throws(()=>apply({...r,selection:{start:0,end:4}}),{code:'idempotency_conflict'});
  const sequence=f.store.room('commons').sequence,privateRequest={...request(),action:'source.grant',memberIds:['producer']},grant=apply(privateRequest);
  assert.equal(f.store.room('commons').sequence,sequence);
  assert.equal(f.store.inbox.readGrant(f.keys.producer,'commons',grant.receipt.grantId).body,message.body);
  assert.throws(()=>f.store.inbox.readGrant(f.keys.reviewer,'commons',grant.receipt.grantId),{status:404});
  assert.equal(apply(privateRequest).duplicate,true);assert.ok(auditRecovery(f.store));
  const result=prepareInboxResult(f,slot.token,auth.sessionBinding,{sourceId,shareReceipt:receipt,ready:false});
  result.complete();
  assert.notEqual(result.selected().status,'ready');
  assert.throws(()=>apply(result.adoption()));
  result.review();assert.notEqual(result.selected().status,'ready');
  result.decide();assert.equal(result.selected().status,'ready');
  const adoption=result.adoption();apply(adoption);assert.equal(apply(adoption).duplicate,true);
  const saved=f.store.inbox.read(slot.token,sourceId,auth.sessionBinding).draft;
  assert.equal(saved.body,result.body);assert.equal(saved.origin.unchanged,true);
  assert.equal(f.store.inbox.sends(slot.token,sourceId,auth.sessionBinding).sends.length,0);
  assert.throws(()=>f.store.inbox.sendContext(slot.token,sourceId,auth.sessionBinding),{code:'email_sending_unavailable'});
  assert.ok(auditRecovery(f.store));
});
