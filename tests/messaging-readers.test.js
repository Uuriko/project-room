import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import twilio from 'twilio';
import { readTwilioMessage } from '../server/twilio-message-reader.mjs';
import { readSlackEvent } from '../server/slack-event-reader.mjs';

test('Twilio SMS/WhatsApp verify all fields and bind destination/account', () => {
  const connection = {active:true,accountId:'a',connectionId:'twilio-one',accountSid:'AC'+'a'.repeat(32),authToken:'fixture-secret',webhookUrl:'https://example.test/incoming?key=public',addresses:['+14155550100','whatsapp:+14155550100']};
  const base = {AccountSid:connection.accountSid,MessageSid:'SM'+'b'.repeat(32),From:'+14155550101',To:'+14155550100',NumMedia:'0',Body:'Hello',FutureField:'included'};
  const read = (params, changes={}) => readTwilioMessage({connection,contentType:'application/x-www-form-urlencoded',rawBody:new URLSearchParams(params).toString(),signature:twilio.getExpectedTwilioSignature(connection.authToken,connection.webhookUrl,params),...changes});
  const a=read(base); assert.equal(a.channel,'sms'); assert.equal(a.text,'Hello'); assert.ok(!JSON.stringify(a).includes('fixture-secret'));
  assert.equal(read({...base,From:'whatsapp:'+base.From,To:'whatsapp:'+base.To}).channel,'whatsapp');
  for(const change of [{AccountSid:'AC'+'c'.repeat(32)},{To:'+14155550199'},{NumMedia:'1'},{Body:''},{From:'whatsapp:'+base.From}]) assert.throws(()=>read({...base,...change}),/unconfirmed/);
  assert.throws(()=>read(base,{signature:'wrong'}),/unconfirmed/);
  assert.throws(()=>read(base,{rawBody:new URLSearchParams({...base,FutureField:'tampered'}).toString()}),/unconfirmed/);
  assert.throws(()=>read(base,{rawBody:new URLSearchParams(base).toString()+'&Body=other'}),/unconfirmed/);
  assert.notEqual(read(base,{connection:{...connection,accountId:'other'}}).sourceId,a.sourceId);
});

test('Slack raw signature, freshness, workspace and channel fences', () => {
  const connection={active:true,accountId:'a',connectionId:'slack-one',teamId:'T1',appId:'A1',channelIds:['C1'],signingSecret:'fixture-secret'};
  const timestamp='1789260000', now=Number(timestamp)*1000;
  const base={type:'event_callback',team_id:'T1',api_app_id:'A1',event_id:'Ev123',event:{type:'message',channel:'C1',user:'U1',ts:'1789260000.000001',text:'Hello'}};
  const read=(body,changes={})=>{const rawBody=JSON.stringify(body),signature='v0='+createHmac('sha256',connection.signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');return readSlackEvent({connection,timestamp,now,rawBody,signature,...changes});};
  assert.equal(read(base).text,'Hello'); assert.equal(read(base).kind,'message');
  assert.throws(()=>read(base,{now:now+301000}),/unconfirmed/);
  assert.throws(()=>read(base,{rawBody:JSON.stringify({...base,event_id:'Ev456'})}),/unconfirmed/);
  assert.throws(()=>read({...base,team_id:'T2'}),/unconfirmed/);
  assert.equal(read({...base,event:{...base.event,channel:'C2'}}).kind,'ignored');
  assert.equal(read({...base,event:{...base.event,subtype:'message_deleted'}}).kind,'ignored');
  assert.deepEqual(read({type:'url_verification',challenge:'test'}),{kind:'challenge',challenge:'test'});
});
