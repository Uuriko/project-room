import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {rmSync} from 'node:fs';
import twilio from 'twilio';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {TwilioConnectionRegistry} from '../server/twilio-connection-registry.mjs';
import {MessagingReceiveGrants} from '../server/messaging-receive-grants.mjs';
import {createTwilioConnections} from '../server/twilio-connections.mjs';
import {importTwilioBackgroundMessage} from '../server/twilio-inbox-import.mjs';

test('receiving consent is account-only, bounded to 24 hours; stop blocks import without disconnecting',async t=>{
  const f=createAcceptanceFixture(),db=new DatabaseSync(':memory:'),gd=new DatabaseSync(':memory:');
  const registry=new TwilioConnectionRegistry({db,key:Buffer.alloc(32,8)}),grants=new MessagingReceiveGrants({db:gd,store:f.store});
  const account=f.store.accountForMember('commons','owner'),slot=f.store.createAccountSessionSlot();
  const auth=f.store.loginAccountSession(slot.token,f.store.issueAccountAccessKey(account.id),0);
  const config={accountId:account.id,connectionId:'sms-one',authEpoch:0,expectedRevision:0,
    accountSid:'AC'+'a'.repeat(32),address:'+14155550100',authToken:'PRIVATE-SENTINEL',webhookUrl:'https://example.test/inbound'};
  registry.configure(config);
  const service=createTwilioConnections({store:f.store,registry,receiveGrants:grants,connections:[{accountId:account.id,connectionId:'sms-one',provider:'sms'}]});
  const server=createRoomServer({store:f.store,twilioConnections:service});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));grants.close();registry.close();gd.close();db.close();f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`,url=origin+'/api/inbox/connections/twilio/receiving';
  const headers={Cookie:`account_session=${slot.token}`,Origin:origin,'Content-Type':'application/json','X-Session-Binding':auth.sessionBinding,'X-CSRF-Token':auth.csrf};
  const data={connectionId:'sms-one',expectedRevision:0,expectedConnectionRevision:1};
  const post=(action='start',value=data,h=headers)=>fetch(url+'/'+action,{method:'POST',headers:h,body:JSON.stringify(value)});
  const state=async()=>{const r=await fetch(url,{headers});assert.equal(r.status,200);return r.json();};
  assert.deepEqual((await state()).connections,[{connectionId:'sms-one',state:'missing',revision:0,expiresAt:null,connectionRevision:null,
    provider:'sms',expectedConnectionRevision:1,canStart:true}]);
  for(const change of [{Cookie:''},{'X-CSRF-Token':''},{Origin:'https://other.test'},{Authorization:'Bearer '+f.keys.owner},{'X-Session-Binding':'0'.repeat(64)}])
    assert.ok((await post('start',data,{...headers,...change})).status>=400);
  for(const change of [{expiresAt:Date.now()+1e10},{send:true},{accountId:account.id}])
    assert.equal((await post('start',{...data,...change})).status,422);
  const guest=f.store.accountForMember('commons','guest'),gs=f.store.createAccountSessionSlot(),ga=f.store.loginAccountSession(gs.token,f.store.issueAccountAccessKey(guest.id),0);
  const gh={...headers,Cookie:`account_session=${gs.token}`,'X-Session-Binding':ga.sessionBinding,'X-CSRF-Token':ga.csrf};
  assert.deepEqual((await(await fetch(url,{headers:gh})).json()).connections,[]);
  assert.equal((await post('start',data,gh)).status,409);
  const before=f.store.now(),response=await post();assert.equal(response.status,200);
  const receipt=await response.json();assert.equal(receipt.state,'active');assert.equal(receipt.revision,1);
  assert.ok(receipt.expiresAt>=before+86400000&&receipt.expiresAt<=f.store.now()+86400000);
  assert.equal((await post()).status,409);
  const status=await state();assert.equal(status.connections[0].state,'active');
  assert.ok(!JSON.stringify(status).includes('PRIVATE-SENTINEL'));assert.ok(!JSON.stringify(status).includes('+1415'));
  const params={AccountSid:config.accountSid,MessageSid:'SM'+'b'.repeat(32),From:'+14155550101',To:config.address,NumMedia:'0',Body:'Consent test'};
  const receive=()=>importTwilioBackgroundMessage({store:f.store,registry,grants,
    binding:{accountId:account.id,connectionId:'sms-one',provider:'sms',connectionRevision:1,revision:1},
    request:{rawBody:new URLSearchParams(params).toString(),contentType:'application/x-www-form-urlencoded',
      signature:twilio.getExpectedTwilioSignature(config.authToken,config.webhookUrl,params)}});
  assert.equal(receive().imported,1);
  const stop={connectionId:'sms-one',expectedRevision:1};
  assert.equal((await post('stop',stop)).status,200);
  assert.equal((await state()).connections[0].state,'revoked');
  assert.throws(receive);
  assert.equal(registry.status(config).state,'active');
  assert.equal(f.store.inbox.list(slot.token,auth.sessionBinding).sources.length,1);
  assert.equal((await post('stop',stop)).status,409);
});
