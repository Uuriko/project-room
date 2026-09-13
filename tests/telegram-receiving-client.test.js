import test from 'node:test';
import assert from 'node:assert/strict';
import {messagingConnectionsClient} from '../src/messaging-connections-client.js';
test('Telegram receiving transport is provider pinned and validates provider rows',()=>{
  let path,check,data;
  const client=messagingConnectionsClient({request(p,o,c){path=p;check=c;data=o.data;}},'telegram');
  client.receivingStatus();assert.equal(path,'/connections/telegram/receiving');
  const row={connectionId:'one',revision:0,state:'missing',expiresAt:null,connectionRevision:null,provider:'telegram',expectedConnectionRevision:1,canStart:true};
  assert.equal(check({enabled:true,connections:[row]}),true);
  assert.equal(check({enabled:true,connections:[{...row,provider:'sms'}]}),false);
  const intent={connectionId:'one',expectedRevision:0,expectedConnectionRevision:1};
  client.receivingAction('start',intent);intent.connectionId='changed';
  assert.equal(path,'/connections/telegram/receiving/start');assert.equal(data.connectionId,'one');assert.equal(Object.isFrozen(data),true);
  assert.equal(check({connectionId:'one',revision:1,state:'active',expiresAt:123}),true);
  assert.equal(check({connectionId:'changed',revision:1,state:'active',expiresAt:123}),false);
  assert.throws(()=>messagingConnectionsClient({},'../other'),/invalid_messaging_provider/);
});
