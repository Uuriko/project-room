import test from 'node:test';
import assert from 'node:assert/strict';
import { readTelegramBotPage } from '../server/telegram-bot-reader.mjs';

const grant = { active: true, accountId: 'owner', connectionId: 'telegram-one', authEpoch: 0, revision: 1, token: '123456:abcdefghijklmnopqrstuvwxyz', chatIds: [22] };
const update = { update_id: 1, message: { message_id: 7, chat: { id: 22 }, from: { id: 44 }, date: 1700000000, text: '<b>inert text</b>' } };
test('Telegram page is scoped, inert and uses only getUpdates without replying', async () => {
  const calls = [];
  const result = await readTelegramBotPage({ authorize: () => grant, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json({ ok: true, result: [update] });
  } });
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/getUpdates'));
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(JSON.parse(calls[0].options.body).offset, 0);
  assert.equal(result.nextOffset, 2); assert.equal(result.observations[0].text, update.message.text);
  assert.equal(result.observations[0].adapter, 'message'); assert.ok(!JSON.stringify(result).includes(grant.token));
});
test('unselected chats and protected content are not copied', async () => {
  const result = await readTelegramBotPage({ authorize: () => grant, fetchImpl: async () => Response.json({ ok: true, result: [
    { ...update, message: { ...update.message, chat: { id: 99 } } },
    { ...update, update_id: 2, message: { ...update.message, has_protected_content: true } }
  ] }) });
  assert.equal(result.observations.length, 0); assert.equal(result.skipped.length, 2); assert.equal(result.nextOffset, 3);
});
test('authority change, duplicate updates, oversized payload and provider errors fail closed', async () => {
  let active = true;
  await assert.rejects(readTelegramBotPage({ authorize: () => ({ ...grant, active }), fetchImpl: async () => { active = false; return Response.json({ ok: true, result: [update] }); } }), /telegram_read_unconfirmed/);
  for (const fetchImpl of [
    async () => Response.json({ ok: true, result: [update, update] }),
    async () => new Response('x'.repeat(262145)),
    async () => { throw Error(grant.token); }
  ]) await assert.rejects(readTelegramBotPage({ authorize: () => grant, fetchImpl }), { message: 'telegram_read_unconfirmed' });
});
test('message identity is isolated across Project Room accounts', async () => {
  const fetchImpl = async () => Response.json({ ok: true, result: [update] });
  const a = await readTelegramBotPage({ authorize: () => grant, fetchImpl });
  const b = await readTelegramBotPage({ authorize: () => ({ ...grant, accountId: 'someone-else' }), fetchImpl });
  assert.notEqual(a.observations[0].sourceId, b.observations[0].sourceId);
});
