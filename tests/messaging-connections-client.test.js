import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountClient } from '../src/client.js';
import { InboxClient } from '../src/inbox-client.js';
import { messagingConnectionsClient } from '../src/messaging-connections-client.js';
const session={authenticated:true,account:{id:'owner',authEpoch:2},sessionRevision:4,sessionBinding:'a'.repeat(64),csrf:'csrf'};
const viewer={accountId:'owner',authEpoch:2,sessionRevision:4,sessionBinding:session.sessionBinding};
const reply=v=>({ok:true,json:async()=>({contractVersion:1,viewer,...v})});
function setup(fetcher){const account=new AccountClient({fetcher});account.session=structuredClone(session);return {account,client:messagingConnectionsClient(new InboxClient(account))};}
test('receiving status and actions reject malformed grants and pin exact intent',async()=>{
  const row={connectionId:'one',provider:'sms',revision:0,state:'missing',expiresAt:null,connectionRevision:null,expectedConnectionRevision:1,canStart:true};
  const good={enabled:true,connections:[row]};
  assert.equal((await setup(async()=>reply(good)).client.receivingStatus()).connections.length,1);
  for(const bad of [{enabled:false,connections:[row]},{...good,connections:[row,row]},
    {...good,connections:[{...row,send:true}]},{...good,connections:[{...row,state:'active'}]},
    {...good,connections:[{...row,canStart:'yes'}]}])
    await assert.rejects(setup(async()=>reply(bad)).client.receivingStatus(),{code:'invalid_inbox_response'});
  let finish;const f=setup(()=>new Promise(r=>finish=r)),data={connectionId:'one',expectedRevision:0,expectedConnectionRevision:1};
  const pending=f.client.receivingAction('start',data);data.connectionId='other';
  finish(reply({connectionId:'one',revision:1,state:'active',expiresAt:12345}));
  assert.equal((await pending).connectionId,'one');
  assert.throws(()=>f.client.receivingAction('send',{}),/invalid_messaging_action/);
  assert.throws(()=>f.client.receivingAction('start',{...data,send:true}),/invalid_messaging_action/);
});
test('messaging status validates providers, identifiers, revisions and duplicate connection rows',async()=>{
  const row={connectionId:'one',provider:'sms',revision:1,state:'active'};
  const good={enabled:true,connections:[row]};
  assert.equal((await setup(async()=>reply(good)).client.twilioStatus()).connections.length,1);
  for(const bad of [{...good,connections:[null]},{...good,connections:[row,row]}, {...good,connections:[{...row,provider:'unknown'}]},
    {...good,connections:[{...row,revision:-1}]},{...good,connections:[{...row,connectionId:'bad id'}]},
    {...good,connections:[{...row,state:'connected'}]},
    {...good,connections:[{...row,authToken:'unexpected-secret'}]},
    {...good,connections:[['one','sms',1,'active']]}])
    await assert.rejects(setup(async()=>reply(bad)).client.twilioStatus(),{code:'invalid_inbox_response'});
});
test('disconnect validates exact receipt and discards late account responses',async()=>{
  const data={connectionId:'one',expectedRevision:1},good={connectionId:'one',revision:2,state:'disconnected'};
  assert.equal((await setup(async()=>reply(good)).client.twilioDisconnect(data)).revision,2);
  for(const bad of [{...good,connectionId:'two'},{...good,revision:1},{...good,state:'active'}])
    await assert.rejects(setup(async()=>reply(bad)).client.twilioDisconnect(data),{code:'invalid_inbox_response'});
  let finish;const f=setup(()=>new Promise(r=>finish=r));const pending=f.client.twilioDisconnect(data);
  f.account.session={...session,account:{id:'other',authEpoch:0},sessionBinding:'b'.repeat(64)};finish(reply(good));
  await assert.rejects(pending,{code:'obsolete_inbox'});
});

test('disconnect pins intent across caller mutation and rejects extra request fields before transport',async()=>{
  for(const data of [null,[],{connectionId:'one',expectedRevision:1,accountId:'other'},
    {connectionId:'one',expectedRevision:0}]) {
    let called=false;
    const {client}=setup(async()=>{called=true;return reply({});});
    assert.throws(()=>client.twilioDisconnect(data),/invalid_messaging_action/);
    assert.equal(called,false);
  }
  let finish;
  const data={connectionId:'one',expectedRevision:1};
  const {client}=setup(()=>new Promise(resolve=>finish=resolve));
  const pending=client.twilioDisconnect(data);
  data.connectionId='other';data.expectedRevision=90;
  finish(reply({connectionId:'one',revision:2,state:'disconnected'}));
  assert.equal((await pending).connectionId,'one');

  let captured,validate;
  const delayed=messagingConnectionsClient({request(path,options,check){captured=options.data;validate=check;}});
  const original={connectionId:'one',expectedRevision:1};
  delayed.twilioDisconnect(original);
  original.connectionId='other';original.expectedRevision=90;
  assert.deepEqual(captured,{connectionId:'one',expectedRevision:1});
  assert.equal(Object.isFrozen(captured),true);
  assert.equal(validate({connectionId:'other',revision:91,state:'disconnected'}),false);
  assert.equal(validate({connectionId:'one',revision:2,state:'disconnected'}),true);
});
