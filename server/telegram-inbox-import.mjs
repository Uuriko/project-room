import { createHash } from 'node:crypto';

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
