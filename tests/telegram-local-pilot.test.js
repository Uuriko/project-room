import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelegramSetup } from '../scripts/telegram-local-setup.mjs';
import { bindingFromPage, importTelegramPage } from '../scripts/telegram-local-sync.mjs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { readTelegramBotPage } from '../server/telegram-bot-reader.mjs';

test('local capture requires same origin and nonce, verifies bot, writes private file once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-setup-')), file = join(dir, 'bot.json');
  const token = '123456:abcdefghijklmnopqrstuvwxyz'; let calls = 0;
  const server = createTelegramSetup({ file, username: 'ProjectRoomDemigodBot', fetchImpl: async (url, options) => {
    calls++; assert.equal(url, `https://api.telegram.org/bot${token}/getMe`); assert.equal(options.redirect, 'error');
    return Response.json({ok:true,result:{id:123456,is_bot:true,username:'ProjectRoomDemigodBot'}});
  }});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); rmSync(dir,{recursive:true,force:true}); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(origin)).text(), nonce = html.match(/name="nonce" value="([a-f0-9]+)"/)[1];
  const post = (from, n = nonce) => fetch(origin,{method:'POST',headers:{Origin:from},body:new URLSearchParams({nonce:n,token})});
  assert.equal((await post('https://evil.example')).status,403); assert.equal(calls,0);
  assert.equal((await post(origin,'wrong')).status,400); assert.equal(calls,0);
  assert.equal((await post(origin)).status,200); assert.equal(calls,1);
  assert.equal(JSON.parse(readFileSync(file)).token,token); assert.equal(statSync(file).mode & 0o777,0o600);
  assert.equal((await post(origin)).status,403); assert.equal(calls,1);
});

test('binding requires exact challenge in one private human chat', () => {
  const challenge = 'a'.repeat(48), message = {text:`/start ${challenge}`,chat:{type:'private',id:44},from:{id:44,is_bot:false}};
  const page = {ok:true,result:[{message}]}; assert.equal(bindingFromPage(page,challenge),44);
  assert.throws(() => bindingFromPage(page,'b'.repeat(48)));
  assert.throws(() => bindingFromPage({ok:true,result:[{message:{...message,chat:{type:'group',id:44}}}]},challenge));
  assert.throws(() => bindingFromPage({ok:true,result:[{message},{message:{...message,chat:{type:'private',id:45},from:{id:45}}}]},challenge));
});

test('local page import is idempotent and atomic', async t => {
  const f = createAcceptanceFixture(); t.after(() => {f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const account = f.store.accountForMember('commons','owner'), slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token,f.store.issueAccountAccessKey(account.id),0);
  const grant = {active:true, accountId:account.id,connectionId:'telegram-123456',authEpoch:0,revision:1,token:'123456:abcdefghijklmnopqrstuvwxyz',chatIds:[44]};
  const page = await readTelegramBotPage({authorize:()=>grant,fetchImpl:async()=>Response.json({ok:true,result:[{update_id:1,message:{message_id:2,chat:{id:44},from:{id:44},date:1700000000,text:'Test'}}]})});
  const before=f.store.room('commons').sequence;
  assert.equal(importTelegramPage(f.store,slot,session,page).imported,1);
  assert.equal(importTelegramPage(f.store,slot,session,page).imported,0);
  const edited={...page.observations[0],providerRevision:'2',text:'Edited'};
  assert.throws(()=>importTelegramPage(f.store,slot,session,{observations:[edited,{...edited,sourceId:'bad'}],skipped:[]}));
  assert.equal(f.store.inbox.read(slot.token,edited.sourceId,session.sessionBinding).source.paragraphs[0],'Test');
  assert.equal(f.store.room('commons').sequence,before); assert.equal(f.store.inbox.verify().versions,1);
});
