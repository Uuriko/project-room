import { createHash } from 'node:crypto';
import { assertReceiveLease } from './messaging-receive-grants.mjs';

// Called only while the provider registry, receive grant and RoomStore locks
// are held. No session is minted and no private Inbox reads leave this importer.
export function importTelegramBackgroundPage(store,lease,connection,page,assertQueueLease){
  const grant=assertReceiveLease(store,lease);
  if(grant.provider!=='telegram'||connection.revision!==grant.connectionRevision
    ||connection.accountId!==grant.accountId||connection.connectionId!==grant.connectionId
    ||connection.authEpoch!==grant.authEpoch||typeof assertQueueLease!=='function')throw new Error('telegram_grant_unavailable');
  let imported=0;
  for(const o of page.observations){
    assertQueueLease();assertReceiveLease(store,lease);
    if(o.provider!=='telegram'||o.accountId!==grant.accountId||o.connectionId!==grant.connectionId
      ||!connection.chatIds.includes(Number(o.conversationId)))throw new Error('telegram_chat_not_authorized');
    const row=store.db.prepare('SELECT revision FROM private_inbox_sources WHERE account_id=? AND id=?').get(grant.accountId,o.sourceId);
    const previous=row?store.inbox.version(grant.accountId,o.sourceId,row.revision):null;
    if(previous&&(previous.provider!=='telegram'||previous.connectionId!==grant.connectionId))throw new Error('telegram_source_mismatch');
    if(previous&&Number(previous.providerRevision)>=Number(o.providerRevision))continue;
    const data={adapter:o.adapter,provider:o.provider,accountId:o.accountId,connectionId:o.connectionId,
      conversationId:o.conversationId,providerMessageId:o.providerMessageId,providerRevision:o.providerRevision,
      sender:o.sender,recipient:'Project Room Inbox',subject:'Telegram message',paragraphs:[o.text]};
    const requestId='tg-'+createHash('sha256').update(`${o.sourceId}:${o.providerRevision}`).digest('hex');
    store.inbox.importGrantedMessage(lease,{action:'message.import',requestId,sourceId:o.sourceId,expectedRevision:row?.revision??0,data});
    imported++;
  }
  assertQueueLease();assertReceiveLease(store,lease);
  return {imported,skipped:page.skipped.length,acknowledged:false};
}

export function importTelegramPage(store, slot, session, page, assertAuthority = () => {}) {
  return store.transaction(() => {
    store.authenticateAccountSession(slot.token, null, session.sessionBinding);
    assertAuthority();
    let imported = 0;
    for (const o of page.observations) {
      assertAuthority(o);
      const row = store.inbox.list(slot.token, session.sessionBinding).sources.find(s => s.id === o.sourceId);
      const current = row ? store.inbox.read(slot.token, o.sourceId, session.sessionBinding).source : null;
      if (current && Number(current.providerRevision) >= Number(o.providerRevision)) continue;
      const data = { adapter: o.adapter, provider: o.provider, accountId: o.accountId, connectionId: o.connectionId,
        conversationId: o.conversationId, providerMessageId: o.providerMessageId, providerRevision: o.providerRevision,
        sender: o.sender, recipient: 'Project Room Inbox', subject: 'Telegram message', paragraphs: [o.text] };
      const requestId = 'tg-' + createHash('sha256').update(`${o.sourceId}:${o.providerRevision}`).digest('hex');
      store.inbox.importMessage(slot.token, { action: 'message.import', requestId, sourceId: o.sourceId, expectedRevision: row?.revision ?? 0, data }, session.sessionBinding);
      imported++;
    }
    assertAuthority();
    return { imported, skipped: page.skipped.length, acknowledged: false };
  });
}
