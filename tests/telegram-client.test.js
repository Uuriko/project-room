import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountClient } from '../src/client.js';
import { InboxClient } from '../src/inbox-client.js';
const session={authenticated:true,account:{id:'owner',authEpoch:2},sessionRevision:4,sessionBinding:'a'.repeat(64),csrf:'csrf'};
const viewer={accountId:'owner',authEpoch:2,sessionRevision:4,sessionBinding:session.sessionBinding};
const reply=value=>({ok:true,json:async()=>value});
const setup=fetcher=>{const account=new AccountClient({fetcher});account.session=structuredClone(session);return {account,client:new InboxClient(account)};};
test('Telegram receipts pin exact connection and revision',async()=>{
  const data={connectionId:'telegram-one',expectedRevision:1},base={contractVersion:1,viewer,connectionId:'telegram-one',revision:1,imported:2};
  for(const invalid of [{...base,connectionId:'other'},{...base,revision:2},{...base,imported:-1}])
    await assert.rejects(setup(async()=>reply(invalid)).client.telegram('sync',data),{code:'invalid_inbox_response'});
  assert.equal((await setup(async()=>reply(base)).client.telegram('sync',data)).imported,2);
  await assert.rejects(setup(async()=>reply({...base,state:'disconnected'})).client.telegram('disconnect',data),{code:'invalid_inbox_response'});
});
test('Telegram status arriving after account replacement is discarded',async()=>{
  let finish;const f=setup(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.client.telegramStatus();
  f.account.session={...session,account:{id:'new-owner',authEpoch:0},sessionBinding:'b'.repeat(64)};
  finish(reply({contractVersion:1,viewer,enabled:true,connections:[{connectionId:'telegram-one',state:'active',revision:1}]}));
  await assert.rejects(pending,{code:'obsolete_inbox'});
});
