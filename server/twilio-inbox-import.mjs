import { readTwilioMessage } from './twilio-message-reader.mjs';

// Receive-only background path. Actual signature and destination checks remain
// mandatory; grant identity alone is never proof that a provider sent a message.
export function importTwilioBackgroundMessage({store,registry,grants,binding,request}) {
  const account=store.account(binding.accountId);
  return registry.withGrant({accountId:account.id,authEpoch:account.authEpoch,
    connectionId:binding.connectionId,expectedRevision:binding.connectionRevision},connection=>
    grants.withGrant(binding,lease=>{
      const o=readTwilioMessage({...request,connection});
      const result=store.inbox.importGrantedMessage(lease,{
        action:'message.import',requestId:o.sourceId,sourceId:o.sourceId,expectedRevision:0,
        data:{adapter:'message',provider:o.channel,accountId:o.accountId,connectionId:o.connectionId,
          providerAccountId:o.providerAccountId,conversationId:JSON.stringify([o.sender,o.recipient]),
          providerMessageId:o.providerMessageId,providerRevision:'0',sender:o.sender,recipient:o.recipient,
          subject:o.channel==='sms'?'SMS message':'WhatsApp message',paragraphs:[o.text]}});
      return {imported:result.duplicate?0:1,duplicate:result.duplicate===true};
    }));
}

// Host-only, receive-only boundary. The host must supply a current account
// session and hold its connection-registry lock through withConnection().
// Return success to the provider only AFTER this function returns. There is no
// public webhook route, background credential, outbound send, or room sharing.
export function importTwilioMessage({ store, slot, session, withConnection, request }) {
  if (typeof withConnection !== 'function') throw new Error('twilio_connection_required');
  return withConnection(connection => store.transaction(() => {
    const auth = store.authenticateAccountSession(slot.token, null, session.sessionBinding);
    if (connection.authEpoch !== auth.account.authEpoch || !Number.isSafeInteger(connection.revision) || connection.revision < 1)
      throw new Error('twilio_connection_unconfirmed');
    const o = readTwilioMessage({ ...request, connection });
    const data = { adapter: 'message', provider: o.channel, accountId: o.accountId,
      connectionId: o.connectionId, providerAccountId: o.providerAccountId,
      conversationId: JSON.stringify([o.sender, o.recipient]), providerMessageId: o.providerMessageId,
      providerRevision: '0', sender: o.sender, recipient: o.recipient,
      subject: o.channel === 'sms' ? 'SMS message' : 'WhatsApp message', paragraphs: [o.text] };
    // Stable request ID uses the journal's exact-request replay comparison:
    // same SID+body returns its receipt; same SID with altered text fails.
    const result = store.inbox.importMessage(slot.token, { action: 'message.import',
      requestId: o.sourceId, sourceId: o.sourceId, expectedRevision: 0, data }, session.sessionBinding);
    return { imported: result.duplicate ? 0 : 1, duplicate: result.duplicate === true };
  }));
}
