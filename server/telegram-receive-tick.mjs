import { createHash } from 'node:crypto';
import { readTelegramBotPage } from './telegram-bot-reader.mjs';

// One bounded receive cycle. Scheduling and single-owner bot lease are host duties.
// commitPage must durably and idempotently commit a page, returning { committed:true }.
export async function receiveTelegramTick({ queue, authorize, commitPage, fetchImpl = fetch }) {
  const stamp = grant => createHash('sha256').update(JSON.stringify(grant)).digest('hex');
  const initial = await authorize(), expected = stamp(initial);
  const check = async () => {
    const current = await authorize();
    if (current?.active !== true || current.accountId !== queue.accountId || current.connectionId !== queue.connectionId
      || current.authEpoch !== queue.authEpoch || stamp(current) !== expected) throw new Error('telegram_authority_changed');
    return current;
  };
  let delivered = 0;
  const drain = async () => {
    for (const item of queue.pending()) {
      await check();
      const result = await commitPage(item.page);
      if (result?.committed !== true) throw new Error('telegram_import_unconfirmed');
      await check();
      queue.markDelivered(item.startOffset,item.fingerprint); delivered++;
    }
  };
  await check(); await drain();
  const offset = queue.nextOffset();
  const page = await readTelegramBotPage({authorize:check,offset,fetchImpl});
  await check();
  queue.stage(offset,page); // synchronous atomic persistence before any future ACK
  await drain();
  return {deliveredPages:delivered,nextOffset:queue.nextOffset()};
}
