// Explicit, one-page local pilot. Never acknowledges updates or runs in background.
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importTelegramPage } from '../server/telegram-inbox-import.mjs';
export { importTelegramPage } from '../server/telegram-inbox-import.mjs';
import { RoomStore } from '../server/store.mjs';
import { readTelegramBotPage } from '../server/telegram-bot-reader.mjs';

function privateJSON(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 4096) throw new Error('Private file required');
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function bindingFromPage(page, challenge) {
  if (!/^[a-f0-9]{48}$/.test(challenge) || page?.ok !== true || !Array.isArray(page.result) || page.result.length > 25) throw new Error('Binding unconfirmed');
  const matches = page.result.filter(u => u.message?.text === `/start ${challenge}` && u.message.chat?.type === 'private'
    && Number.isSafeInteger(u.message.from?.id) && u.message.from.id > 0 && u.message.from.id === u.message.chat.id && !u.message.from.is_bot);
  const chats = new Set(matches.map(u => u.message.chat.id));
  if (chats.size !== 1) throw new Error('Binding unconfirmed');
  return [...chats][0];
}

export async function syncLocalTelegram(directory) {
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw new Error('Private directory required');
  const credential = privateJSON(join(directory, 'telegram-bot.json'));
  if (credential.username !== 'ProjectRoomDemigodBot' || !/^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(credential.token)
    || String(credential.botId) !== credential.token.split(':')[0]) throw new Error('Invalid bot');
  const dbStat = lstatSync(join(directory, 'room.sqlite'));
  if (!dbStat.isFile() || dbStat.isSymbolicLink()) throw new Error('Existing database required');
  const store = new RoomStore(join(directory, 'room.sqlite'));
  let slot, session;
  try {
    const keyFile = join(directory, 'account-key'), stat = lstatSync(keyFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 256) throw new Error('Private key required');
    slot = store.createAccountSessionSlot();
    session = store.loginAccountSession(slot.token, readFileSync(keyFile, 'utf8').trim(), 0);
    const file = join(directory, 'telegram-binding.json');
    let binding;
    try { binding = privateJSON(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const response = await fetch(`https://api.telegram.org/bot${credential.token}/getUpdates`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offset: 0, limit: 25, timeout: 0, allowed_updates: ['message','edited_message'] }) });
      const chunks = []; let size = 0; const reader = response.body.getReader();
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 262144) { await reader.cancel(); throw new Error(); } chunks.push(value); }
      if (!response.ok) throw new Error();
      const chatId = bindingFromPage(JSON.parse(Buffer.concat(chunks).toString('utf8')), credential.challenge);
      binding = { accountId: session.account.id, botId: credential.botId, chatId };
      writeFileSync(file, JSON.stringify(binding), { flag: 'wx', mode: 0o600 });
    }
    if (binding.accountId !== session.account.id || binding.botId !== credential.botId) throw new Error('Binding changed');
    const authorize = () => { const current = store.authenticateAccountSession(slot.token, null, session.sessionBinding);
      return { active: true, accountId: current.account.id, connectionId: `telegram-${credential.botId}`, authEpoch: current.account.authEpoch,
        revision: 1, token: credential.token, chatIds: [binding.chatId] }; };
    const page = await readTelegramBotPage({ authorize, offset: 0 });
    const pageFull = page.observations.length + page.skipped.length === 25;
    // Do not retain the one-time linking challenge as an Inbox message.
    page.observations = page.observations.filter(o => o.text !== `/start ${credential.challenge}`);
    return { ...importTelegramPage(store, slot, session, page), mode: 'manual-first-page', pageFull,
      ...(pageFull ? { warning: 'Queue page full. Durable cursor required to receive later messages.' } : {}) };
  } finally {
    if (session) store.logoutAccountSession(slot.token, session.sessionRevision);
    store.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await syncLocalTelegram(process.argv[2]))); }
  catch { console.error('Telegram sync unconfirmed. No credentials or message content logged.'); process.exitCode = 1; }
}
