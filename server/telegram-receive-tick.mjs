import { createHash } from 'node:crypto';
import { readTelegramBotPage } from './telegram-bot-reader.mjs';

// One bounded receive cycle. All workers for one bot must use the same queue DB.
// commitPage must durably and idempotently commit a page, returning { committed:true }.
export async function receiveTelegramTick({ queue, authorize, commitPage, fetchImpl = fetch }) {
  const lease = queue.acquireLease();
  try {
  const stamp = grant => createHash('sha256').update(JSON.stringify(grant)).digest('hex');
  const initial = await authorize(), expected = stamp(initial);
  const check = async () => {
    queue.assertLease(lease);
    const current = await authorize();
    queue.assertLease(lease);
    if (current?.active !== true || current.accountId !== queue.accountId || current.connectionId !== queue.connectionId
      || current.authEpoch !== queue.authEpoch || stamp(current) !== expected) throw new Error('telegram_authority_changed');
    return current;
  };
  let delivered = 0;
  const drain = async () => {
    for (const item of queue.pending()) {
      await check();
      const result = await commitPage(item.page, { assertLease: () => queue.assertLease(lease) });
      if (result?.committed !== true) throw new Error('telegram_import_unconfirmed');
      await check();
      queue.markDelivered(item.startOffset,item.fingerprint,lease); delivered++;
    }
  };
  await check(); await drain();
  queue.pruneDelivered(Math.min(16,queue.maxPages - 1),lease);
  const offset = queue.nextOffset();
  const page = await readTelegramBotPage({authorize:check,offset,fetchImpl});
  await check();
  queue.stage(offset,page,lease); // synchronous atomic persistence before any future ACK
  await drain();
  return {deliveredPages:delivered,nextOffset:queue.nextOffset()};
  } finally { queue.releaseLease(lease); }
}
