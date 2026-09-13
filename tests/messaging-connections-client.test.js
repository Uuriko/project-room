import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountClient } from '../src/client.js';
import { InboxClient } from '../src/inbox-client.js';
import { messagingConnectionsClient } from '../src/messaging-connections-client.js';
const session={authenticated:true,account:{id:'owner',authEpoch:2},sessionRevision:4,sessionBinding:'a'.repeat(64),csrf:'csrf'};
const viewer={accountId:'owner',authEpoch:2,sessionRevision:4,sessionBinding:session.sessionBinding};
const reply=v=>({ok:true,json:async()=>({contractVersion:1,viewer,...v})});
function setup(fetcher){const account=new AccountClient({fetcher});account.session=structuredClone(session);return {account,client:messagingConnectionsClient(new InboxClient(account))};}
test('messaging status validates providers, identifiers, revisions and duplicate connection rows',async()=>{
  const row={connectionId:'one',provider:'sms',revision:1,state:'active'};
  const good={enabled:true,connections:[row]};
  assert.equal((await setup(async()=>reply(good)).client.twilioStatus()).connections.length,1);
  for(const bad of [{...good,connections:[null]},{...good,connections:[row,row]}, {...good,connections:[{...row,provider:'unknown'}]},
    {...good,connections:[{...row,revision:-1}]},{...good,connections:[{...row,connectionId:'bad id'}]},
    {...good,connections:[{...row,state:'connected'}]}])
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
