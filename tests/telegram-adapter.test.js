import test from "node:test";
import assert from "node:assert/strict";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { normalizeTelegramUpdate, readTelegramEnvelope, telegramSourceId, telegramUpdates, RecordedTelegramBot, bind } from "../server/channel-adapters/telegram.mjs";
import { EmailContractError } from "../server/email-envelope.mjs";
import { readChannelEnvelope } from "../server/channel-adapters/index.mjs";

const f = () => telegramContractFixture();
test("text, caption, attachment, edited and channel-post updates normalize into one bounded envelope", () => {
  const { connection, updates } = f();
  const text = normalizeTelegramUpdate(connection, updates[0]);
  assert.equal(text.channel, "telegram"); assert.equal(text.contractVersion, 1);
  assert.equal(text.sourceId, telegramSourceId(connection, "-1001000000001:41"));
  assert.match(text.sourceId, /^telegram-[a-f0-9]{64}$/);
  assert.deepEqual(text.message, { id: "-1001000000001:41", revision: "900001", threadId: "-1001000000001", kind: "message", sentAt: "2026-09-09T10:00:00.000Z", editedAt: null,
    from: { kind: "user", id: "5000000001", handle: "@avery_q", displayName: "Avery Quinn" },
    to: [{ kind: "group", id: "-1001000000001", handle: "", displayName: "Fixture planning" }], subject: null, replyTo: null });
  assert.deepEqual(text.body, { format: "text", content: "Shall we work on this together?\n\nPrivate budget: 4200." });
  assert.deepEqual(text.attachments, []);
  const document = normalizeTelegramUpdate(connection, updates[1]);
  assert.equal(document.body.content, "Brief attached"); assert.equal(document.message.replyTo, "-1001000000001:41");
  assert.deepEqual(document.attachments, [{ id: "BQACAgIAAxkBAAIFixtureDoc", kind: "document", name: "brief.txt", contentType: "text/plain", size: 128 }]);
  assert.equal(JSON.stringify(document).includes("AgADfixture"), false, "file_unique_id and bytes never enter the envelope");
  const photo = normalizeTelegramUpdate(connection, updates[2]);
  assert.deepEqual(photo.attachments, [{ id: "AgACAgIAAxkBAAIFixtureLarge", kind: "photo", name: null, contentType: null, size: 90000 }]);
  const edited = normalizeTelegramUpdate(connection, updates[4]);
  assert.equal(edited.sourceId, text.sourceId, "an edit is a new version of the same source");
  assert.notEqual(edited.sourceVersion, text.sourceVersion);
  assert.equal(edited.message.kind, "edited_message"); assert.equal(edited.message.editedAt, "2026-09-09T10:05:00.000Z");
  const post = normalizeTelegramUpdate(connection, updates[5]);
  assert.deepEqual(post.message.from, { kind: "channel", id: "-1001000000002", handle: "@fixture_news", displayName: "Fixture announcements" });
  assert.equal(post.message.to[0].kind, "channel");
  for (const envelope of [text, document, photo, edited, post]) {
    assert.deepEqual(readTelegramEnvelope(envelope), envelope);
    assert.deepEqual(readChannelEnvelope(structuredClone(envelope)), envelope);
  }
  assert.throws(() => normalizeTelegramUpdate(connection, updates[3]), { code: "unsupported_telegram_update" });
  for (const change of [u => delete u.message.chat, u => u.message.message_id = "41", u => u.message.date = -1, u => u.message.chat.type = "secret",
    u => u.message.text = "x".repeat(20000), u => u.update_id = 1.5, u => u.message.from = { id: "5" }]) {
    const update = structuredClone(updates[0]); change(update);
    assert.throws(() => normalizeTelegramUpdate(connection, update), EmailContractError);
  }
  for (const change of [e => e.sourceVersion = "0".repeat(64), e => e.channel = "email", e => e.message.subject = "Subject", e => e.body.format = "html",
    e => e.message.to.push(e.message.to[0]), e => e.attachments.push(e.attachments[0] ?? { id: "x", kind: "photo", name: null, contentType: null, size: null }),
    e => e.extra = 1, e => e.message.from.kind = "person", e => e.connection.provider = "microsoft-graph"]) {
    const envelope = structuredClone(document); change(envelope);
    assert.throws(() => readTelegramEnvelope(envelope), EmailContractError);
  }
  const other = { ...connection, accountId: "someone-else" };
  assert.notEqual(normalizeTelegramUpdate(other, updates[0]).sourceId, text.sourceId, "source identity is account scoped");
});
test("a recorded bot pages getUpdates by offset; the bound adapter hydrates the latest update per message", async () => {
  const { connection, updates } = f(), reader = new RecordedTelegramBot({ connection, updates, limit: 4 });
  assert.deepEqual(reader.connection, connection);
  const first = await reader.getUpdates({ offset: null });
  assert.deepEqual(first.result.map(u => u.update_id), [900001, 900002, 900003, 900004]);
  const page = telegramUpdates(connection, first, { offset: null, limit: 4 });
  assert.deepEqual(page.changes.map(c => c.messageId), ["-1001000000001:41", "-1001000000001:42", "-1001000000001:43"], "callback queries are not messages");
  assert.equal(page.cursor, "900005"); assert.equal(page.complete, false);
  const second = telegramUpdates(connection, await reader.getUpdates({ offset: page.cursor }), { offset: page.cursor, limit: 4 });
  assert.deepEqual(second.changes.map(c => c.messageId), ["-1001000000001:41", "-1001000000002:7"]);
  assert.equal(second.cursor, "900007"); assert.equal(second.complete, true);
  const empty = telegramUpdates(connection, await reader.getUpdates({ offset: "900007" }), { offset: "900007", limit: 4 });
  assert.deepEqual(empty, { ...empty, changes: [], cursor: "900007", complete: true });
  assert.throws(() => telegramUpdates(connection, { ok: true, result: [updates[1], updates[0]] }), { code: "invalid_telegram_updates" });
  assert.throws(() => telegramUpdates(connection, { ok: false, result: [] }), { code: "invalid_telegram_updates" });
  assert.throws(() => telegramUpdates(connection, first, { offset: "abc" }), { code: "invalid_telegram_cursor" });
  assert.throws(() => new RecordedTelegramBot({ connection, updates: [updates[1], updates[0]] }), { code: "invalid_telegram_recording" });
  assert.throws(() => new RecordedTelegramBot({ connection: { ...connection, provider: "microsoft-graph" }, updates }), EmailContractError);
  const adapter = bind({ reader: new RecordedTelegramBot({ connection, updates }), connection });
  assert.deepEqual([adapter.channel, adapter.provider, adapter.scope()], ["telegram", "telegram-bot", "updates"]);
  for (const key of ["normalize", "changes", "hydrate", "submit", "lookup", "sourceId"]) assert.equal(typeof adapter[key], "function", key);
  const all = await adapter.changes({ cursor: null });
  assert.equal(all.complete, true); assert.equal(all.cursor, "900007");
  const latest = await adapter.hydrate("-1001000000001:41");
  assert.equal(latest.update_id, 900005, "the edit supersedes the original within one page");
  assert.equal(adapter.normalize(latest).message.kind, "edited_message");
  assert.equal(await adapter.hydrate("-1001000000001:999"), null);
  assert.equal(adapter.sourceId("-1001000000001:41"), telegramSourceId(connection, "-1001000000001:41"));
});
