import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import twilio from 'twilio';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { importTwilioMessage } from '../server/twilio-inbox-import.mjs';
import { auditRecovery } from '../server/recovery.mjs';

for (const channel of ['sms', 'whatsapp']) test(`${channel}: signed private import, exact replay, tamper and account isolation`, t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, {recursive:true, force:true}); });
  const account = f.store.accountForMember('commons', 'owner'), slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
  const prefix = channel === 'sms' ? '' : 'whatsapp:';
  const connection = {active:true, accountId:account.id, connectionId:'twilio-one', authEpoch:0, revision:1,
    accountSid:'AC'+'a'.repeat(32), authToken:'fixture-secret', webhookUrl:'https://example.test/incoming', addresses:[prefix+'+14155550100']};
  const params = {AccountSid:connection.accountSid, MessageSid:'SM'+'b'.repeat(32),
    From:prefix+'+14155550101', To:connection.addresses[0], NumMedia:'0', Body:'Private incoming text'};
  const incoming = (p=params, c=connection, extra={}) => importTwilioMessage({store:f.store,slot,session,
    withConnection:fn=>fn(c),request:{rawBody:new URLSearchParams(p).toString(), contentType:'application/x-www-form-urlencoded',
      signature:twilio.getExpectedTwilioSignature(connection.authToken,connection.webhookUrl,p)}, ...extra});
  const sequence = f.store.room('commons').sequence;
  assert.deepEqual(incoming(), {imported:1,duplicate:false});
  assert.deepEqual(incoming(), {imported:0,duplicate:true});
  assert.throws(() => incoming({...params,Body:'Altered replay'}));
  assert.throws(() => incoming({...params,MessageSid:'SM'+'c'.repeat(32)}, {...connection,active:false}));
  assert.throws(() => incoming(params, {...connection,authEpoch:1}), /unconfirmed/);
  assert.throws(() => incoming(params, {...connection,revision:0}), /unconfirmed/);
  const rows = f.store.inbox.list(slot.token,session.sessionBinding).sources;
  assert.equal(rows.length,1);
  const source = f.store.inbox.read(slot.token,rows[0].id,session.sessionBinding).source;
  assert.equal(source.provider,channel);
  assert.deepEqual(source.paragraphs,[params.Body]);
  assert.equal(f.store.room('commons').sequence,sequence);
  const guest = f.store.accountForMember('commons','guest'), guestSlot=f.store.createAccountSessionSlot();
  const guestSession=f.store.loginAccountSession(guestSlot.token,f.store.issueAccountAccessKey(guest.id),0);
  assert.throws(() => incoming(params,connection,{slot:guestSlot,session:guestSession}), {code:'message_account_mismatch'});
  assert.equal(f.store.inbox.list(guestSlot.token,guestSession.sessionBinding).sources.length,0);
  assert.throws(() => incoming(params,connection,{withConnection:()=>{ throw new Error('connection unavailable'); }}));
  assert.equal(f.store.inbox.verify().versions,1);
  assert.ok(auditRecovery(f.store));
});
