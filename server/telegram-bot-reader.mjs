import { createHash } from 'node:crypto';

const fail = () => { throw new Error('telegram_read_unconfirmed'); };
const integer = value => Number.isSafeInteger(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Optional transport boundary, not a running connector. Host supplies a private
// token and explicit allowed chats. Persist the returned page BEFORE using its
// nextOffset: getUpdates acknowledges older updates when that offset is sent.
export async function readTelegramBotPage({ authorize, offset = 0, fetchImpl = fetch }) {
  if (!integer(offset) || offset < 0) fail();
  let initial;
  try {
    initial = await authorize();
    if (initial?.active !== true || typeof initial.token !== 'string' || initial.token.length > 128 || !/^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(initial.token)
      || typeof initial.accountId !== 'string' || !initial.accountId || typeof initial.connectionId !== 'string' || !initial.connectionId
      || !integer(initial.authEpoch) || initial.authEpoch < 0 || !integer(initial.revision) || initial.revision < 1
      || !Array.isArray(initial.chatIds) || !initial.chatIds.length || initial.chatIds.length > 100
      || !initial.chatIds.every(id => integer(id) && id !== 0)) fail();
    const stamp = hash(initial);
    const response = await fetchImpl(`https://api.telegram.org/bot${initial.token}/getUpdates`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset, limit: 25, timeout: 0, allowed_updates: ['message', 'edited_message'] })
    });
    if (!response.ok) { await response.body?.cancel(); fail(); }
    const reader = response.body?.getReader(); if (!reader) fail();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 262144) { await reader.cancel(); fail(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (hash(await authorize()) !== stamp || body.ok !== true || !Array.isArray(body.result) || body.result.length > 25) fail();
    const observations = [], skipped = []; let last = offset - 1;
    for (const update of body.result) {
      if (!integer(update?.update_id) || update.update_id < offset || update.update_id <= last || update.update_id >= Number.MAX_SAFE_INTEGER) fail();
      last = update.update_id;
      const m = update.message ?? update.edited_message;
      if (!m || !initial.chatIds.includes(m.chat?.id)) { skipped.push({ updateId: last, reason: 'outside_selected_chats' }); continue; }
      if (m.has_protected_content || m.ephemeral_message_id || m.receiver_user || typeof m.text !== 'string') { skipped.push({ updateId: last, reason: 'unsupported_content' }); continue; }
      if (!integer(m.message_id) || m.message_id < 1 || !integer(m.date) || m.date < 0 || m.date > 8640000000000
        || !integer(m.from?.id) || typeof m.text !== 'string' || !m.text.isWellFormed() || m.text.length > 4096) fail();
      observations.push({ adapter: 'message', provider: 'telegram',
        accountId: initial.accountId, connectionId: initial.connectionId,
        sourceId: 'tg-' + hash([initial.accountId, initial.connectionId, m.chat.id, m.message_id]),
        conversationId: String(m.chat.id), providerMessageId: String(m.message_id),
        providerRevision: String(last), sender: String(m.from.id), text: m.text, sentAt: m.date * 1000 });
    }
    if (hash(await authorize()) !== stamp) fail();
    return { observations, skipped, nextOffset: last + 1 };
  } catch { fail(); } // Never propagate a token-bearing URL or provider exception.
}
