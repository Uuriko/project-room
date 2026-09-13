import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import twilio from 'twilio';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {TwilioConnectionRegistry} from '../server/twilio-connection-registry.mjs';
import {MessagingReceiveGrants,assertReceiveLease} from '../server/messaging-receive-grants.mjs';
import {importTwilioBackgroundMessage} from '../server/twilio-inbox-import.mjs';

for(const provider of ['sms','whatsapp'])test(`${provider}: signed background import after sign-out, private recovery and both revocation gates`,t=>{
  const f=createAcceptanceFixture(),db=new DatabaseSync(join(f.directory,'twilio.sqlite')),
    grantDb=new DatabaseSync(join(f.directory,'grants.sqlite'));
  const registry=new TwilioConnectionRegistry({db,key:randomBytes(32)}),grants=new MessagingReceiveGrants({db:grantDb,store:f.store});
  t.after(()=>{grants.close();registry.close();db.close();grantDb.close();f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const account=f.store.accountForMember('commons','owner'),slot=f.store.createAccountSessionSlot(),key=f.store.issueAccountAccessKey(account.id);
  let auth=f.store.loginAccountSession(slot.token,key,0);
  const prefix=provider==='whatsapp'?'whatsapp:':'';
  const config={accountId:account.id,connectionId:'one',authEpoch:account.authEpoch,expectedRevision:0,
    accountSid:'AC'+'a'.repeat(32),address:prefix+'+14155550100',authToken:'fixture-secret',webhookUrl:'https://example.test/inbound'};
  registry.configure(config);
  const issued=grants.issue({token:slot.token,binding:auth.sessionBinding},{connectionId:'one',provider,connectionRevision:1,
    expectedRevision:0,expiresAt:f.store.now()+60000});
  const binding={accountId:account.id,connectionId:'one',provider,connectionRevision:1,revision:issued.revision};
  const params={AccountSid:config.accountSid,MessageSid:'SM'+'b'.repeat(32),From:prefix+'+14155550101',To:config.address,NumMedia:'0',Body:'Background private text'};
  const request=p=>({rawBody:new URLSearchParams(p).toString(),contentType:'application/x-www-form-urlencoded',
    signature:twilio.getExpectedTwilioSignature(config.authToken,config.webhookUrl,p)});
  const receive=(p=params,b=binding)=>importTwilioBackgroundMessage({store:f.store,registry,grants,binding:b,request:request(p)});
  const sequence=f.store.room('commons').sequence;
  const signedOut=f.store.logoutAccountSession(slot.token,auth.sessionRevision);
  const originalImport=f.store.inbox.importGrantedMessage,originalNow=f.store.now;
  f.store.inbox.importGrantedMessage=function(...args){
    const result=originalImport.apply(this,args);
    f.store.now=()=>issued.expiresAt;
    return result;
  };
  try{assert.throws(()=>receive(),/unconfirmed/);}
  finally{f.store.inbox.importGrantedMessage=originalImport;f.store.now=originalNow;}
  assert.equal(f.store.inbox.verify().versions,0);
  assert.deepEqual(receive(),{imported:1,duplicate:false});
  assert.deepEqual(receive(),{imported:0,duplicate:true});
  assert.throws(()=>receive({...params,Body:'Altered replay'}));
  assert.throws(()=>receive({...params,To:prefix+'+14155550999'}));
  assert.throws(()=>f.store.inbox.list(slot.token,auth.sessionBinding));
  assert.equal(f.store.room('commons').sequence,sequence);
  assert.equal(f.store.inbox.verify().versions,1);

  let escaped;
  grants.withGrant(binding,lease=>{
    escaped=lease;
    assert.equal(assertReceiveLease(f.store,lease),lease);
    assert.throws(()=>assertReceiveLease(f.store,{...lease}),/unconfirmed/);
    assert.throws(()=>f.store.inbox.importGrantedMessage(lease,{action:'source.share'}),{code:'message_grant_mismatch'});
    assert.throws(()=>f.store.inbox.apply(lease,{action:'message.import'}));
  });
  assert.throws(()=>f.store.inbox.importGrantedMessage(escaped,{}),/unconfirmed/);
  auth=f.store.loginAccountSession(slot.token,key,signedOut.sessionRevision);
  assert.equal(f.store.inbox.list(slot.token,auth.sessionBinding).sources.length,1);
  const session={token:slot.token,binding:auth.sessionBinding};
  grants.revoke(session,{connectionId:'one',expectedRevision:1});
  const next={...params,MessageSid:'SM'+'c'.repeat(32)};
  assert.throws(()=>receive(next));
  const renewed=grants.issue(session,{connectionId:'one',provider,connectionRevision:1,expectedRevision:2,expiresAt:f.store.now()+60000});
  registry.disconnect({...config,expectedRevision:1});
  assert.throws(()=>receive(next,{...binding,revision:renewed.revision}));
  assert.equal(f.store.inbox.list(slot.token,auth.sessionBinding).sources.length,1);
});
