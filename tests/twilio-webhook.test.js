import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { connect } from 'node:net';
import twilio from 'twilio';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { TwilioConnectionRegistry } from '../server/twilio-connection-registry.mjs';
import { createTwilioWebhookServer } from '../server/twilio-webhook.mjs';

test('webhook routes require exactly one explicit authority mode',()=>{
  const background={registry:{withGrant(){}},grants:{withGrant(){}},getBinding(){}};
  for(const route of [null,{path:'/webhooks/twilio/one'},
    {path:'/webhooks/twilio/one',background:null},
    {path:'/webhooks/twilio/one',background:{...background,getBinding:null}},
    {path:'/webhooks/twilio/one',background,getSession(){}},
    {path:'/webhooks/twilio/one',background,withConnection(){}},
    {path:'/webhooks/twilio/one?extra=1',background}])
    assert.throws(()=>createTwilioWebhookServer({store:{},routes:[route]}),/invalid_twilio_webhook_config/);
  const server=createTwilioWebhookServer({store:{},routes:[{path:'/webhooks/twilio/one',background}]});
  assert.equal(server.listening,false);server.close();
});

async function fixture(t,limit=60) {
  const f=createAcceptanceFixture(),db=new DatabaseSync(':memory:'),registry=new TwilioConnectionRegistry({db,key:Buffer.alloc(32,7)});
  const account=f.store.accountForMember('commons','owner'),slot=f.store.createAccountSessionSlot();
  const session=f.store.loginAccountSession(slot.token,f.store.issueAccountAccessKey(account.id),0);
  const c={accountId:account.id,connectionId:'sms-one',authEpoch:0,expectedRevision:0,accountSid:'AC'+'a'.repeat(32),
    address:'+14155550100',authToken:'secret-fixture',webhookUrl:'https://example.test/webhooks/twilio/sms-one'};
  registry.configure(c);const binding={...c,expectedRevision:1};
  const server=createTwilioWebhookServer({store:f.store,limit,routes:[{path:'/webhooks/twilio/sms-one',getSession:()=>({slot,session}),withConnection:fn=>registry.withGrant(binding,fn)}]});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));registry.close();db.close();f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const p={AccountSid:c.accountSid,MessageSid:'SM'+'b'.repeat(32),From:'+14155550101',To:c.address,NumMedia:'0',Body:'Signed HTTP private message'};
  const url=`http://127.0.0.1:${server.address().port}/webhooks/twilio/sms-one`;
  const send=(params=p,options={})=>fetch(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',
    'x-twilio-signature':twilio.getExpectedTwilioSignature(c.authToken,c.webhookUrl,params)},body:new URLSearchParams(params).toString(),...options});
  return {f,registry,binding,slot,session,p,url,send};
}
test('signed HTTP delivery commits privately before empty TwiML; duplicate safe, disconnect blocks',async t=>{
  const {f,registry,binding,slot,session,p,send}=await fixture(t);
  const first=await send();assert.equal(first.status,200);assert.equal(await first.text(),'<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  assert.equal(f.store.inbox.list(slot.token,session.sessionBinding).sources.length,1);
  assert.equal((await send()).status,200);assert.equal(f.store.inbox.verify().versions,1);
  const altered=await send({...p,Body:'Changed replay'});assert.equal(altered.status,503);assert.equal(await altered.text(),'Message not confirmed.');
  registry.disconnect(binding);assert.equal((await send()).status,503);
});
test('HTTP rejects bad signature, destination, format, unknown path and oversized body without import',async t=>{
  const {f,slot,session,p,url,send}=await fixture(t);
  assert.equal((await fetch(url)).status,405);
  assert.equal((await fetch(url+'?extra=1',{method:'POST'})).status,404);
  assert.equal((await send(p,{headers:{'content-type':'application/json'}})).status,400);
  assert.equal((await send(p,{headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':'bad'}})).status,503);
  assert.equal((await send({...p,To:'+14155550199'})).status,503);
  assert.equal((await send(p,{body:'x'.repeat(65537)})).status,413);
  assert.equal(f.store.inbox.list(slot.token,session.sessionBinding).sources.length,0);
});
test('HTTP rate limit is bounded by configured route, not spoofed forwarding headers',async t=>{
  const {send,p}=await fixture(t,1);
  assert.equal((await send()).status,200);
  const response=await send(p,{headers:{'x-forwarded-for':'other'}});
  assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');
});

test('failure after journal work rolls back before HTTP acknowledgement; retry imports once',async t=>{
  const {f,slot,session,send}=await fixture(t),original=f.store.inbox.importMessage;
  f.store.inbox.importMessage=function(...args){original.apply(this,args);throw new Error('PRIVATE_STORAGE_ERROR');};
  const failed=await send();assert.equal(failed.status,503);assert.equal(await failed.text(),'Message not confirmed.');
  assert.equal(f.store.inbox.list(slot.token,session.sessionBinding).sources.length,0);
  assert.equal(f.store.inbox.verify().versions,0);
  f.store.inbox.importMessage=original;
  assert.equal((await send()).status,200);assert.equal((await send()).status,200);
  assert.equal(f.store.inbox.verify().versions,1);
});

test('partial body expires without acknowledgement or private import', {timeout:12000}, async t=>{
  const {url,f,slot,session}=await fixture(t),parsed=new URL(url);
  const socket=connect({host:parsed.hostname,port:Number(parsed.port)});t.after(()=>socket.destroy());
  const response=await new Promise((resolve,reject)=>{
    let text='';const deadline=setTimeout(()=>reject(new Error('body deadline did not respond')),8000);
    socket.once('error',error=>{clearTimeout(deadline);reject(error);});
    socket.on('data',chunk=>{text+=chunk.toString();if(text.includes('\r\n\r\n')){clearTimeout(deadline);resolve(text);}});
    socket.once('connect',()=>socket.write(`POST ${parsed.pathname} HTTP/1.1\r\nHost: ${parsed.host}\r\nContent-Type: application/x-www-form-urlencoded\r\nX-Twilio-Signature: incomplete-fixture\r\nContent-Length: 100\r\n\r\nBody=partial`));
  });
  assert.match(response,/^HTTP\/1\.1 408 /);
  assert.doesNotMatch(response,/<Response>/);
  assert.equal(f.store.inbox.list(slot.token,session.sessionBinding).sources.length,0);
});
