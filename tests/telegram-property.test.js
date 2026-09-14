import test from "node:test";
import assert from "node:assert/strict";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { normalizeTelegramUpdate, readTelegramEnvelope, telegramSourceId, telegramUpdates, telegramLimits, updateKind } from "../server/channel-adapters/telegram.mjs";
import { EmailContractError } from "../server/email-envelope.mjs";

// Property-style tests: randomised Bot API update shapes from a fixed-seed
// generator, so every run explores the same inputs and failures reproduce.
// PROPERTY_TEST_SEED shifts every seed for an extra exploratory run; the default stays fixed.
const seedOffset = Number(process.env.PROPERTY_TEST_SEED ?? 0);
function rng(seed) {
  let s = (seed + seedOffset) >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = list => list[int(0, list.length - 1)];
  const chance = p => next() < p;
  return { next, int, pick, chance };
}
// Latin, combining marks, CJK, an emoji, a ZWJ family sequence, an RTL mark and whitespace.
const alphabet = ["a", "Z", "0", "9", " ", "é", "ß", "日", "本", "\u{1f600}", "\u{1f469}‍\u{1f469}‍\u{1f467}", "‏", "́", "\n", "\t", "\r", "-", "_", ":", "/", "'", "\"", "<", ">"];
const words = r => Array.from({ length: r.int(0, 12) }, () => r.pick(alphabet)).join("");
const safeWord = r => words(r).replace(/[\n\t\r]/g, "x");
const userNames = ["Avery", "Lee", "Sam", "Morgan", "Ω", "日本語", "", "Émile", "O'Brien"];
const user = r => {
  const u = { id: r.int(1, 9_000_000_000), is_bot: r.chance(0.2), first_name: r.pick(userNames) };
  if (r.chance(0.5)) u.last_name = r.pick(userNames);
  if (r.chance(0.6)) u.username = "user_" + r.int(1, 999_999);
  if (r.chance(0.3)) u.language_code = "en"; // Ignored Bot API noise.
  return u;
};
const chat = r => {
  const type = r.pick(["private", "group", "supergroup", "channel"]);
  const c = { id: type === "private" ? r.int(1, 9_000_000_000) : -r.int(1_000_000_000, 1_009_999_999), type };
  if (type === "private") { c.first_name = r.pick(userNames); if (r.chance(0.5)) c.last_name = r.pick(userNames); }
  else c.title = safeWord(r) || "Room";
  if (r.chance(0.4)) c.username = "chat_" + r.int(1, 999_999);
  return c;
};
const fileKinds = ["document", "audio", "video", "voice", "sticker", "animation", "video_note"];
const mimeTypes = ["text/plain", "application/pdf", "image/png; charset=binary", "APPLICATION/OCTET-STREAM", "audio/ogg", "video/mp4", null];
function update(r, id) {
  const kind = r.pick(["message", "message", "message", "edited_message", "channel_post"]);
  const c = chat(r);
  const m = { message_id: r.int(1, 10_000_000), date: r.int(0, 4_000_000_000), chat: c };
  if (kind === "edited_message") m.edit_date = m.date + r.int(0, 86400);
  if (c.type === "channel") m.sender_chat = { ...c }; else m.from = user(r);
  if (r.chance(0.3)) m.message_thread_id = r.int(1, 100_000);
  if (r.chance(0.3)) m.reply_to_message = { message_id: r.int(1, 10_000_000), date: r.int(0, 4_000_000_000), chat: c };
  const files = fileKinds.filter(() => r.chance(0.15));
  if (r.chance(0.2)) m.photo = Array.from({ length: r.int(1, 4) }, (_, i) => ({ file_id: `photo-${id}-${i}`, file_unique_id: `uniq-${id}-${i}`, width: 10 * (i + 1), height: 8 * (i + 1), file_size: r.chance(0.8) ? 100 * (i + 1) : undefined }));
  for (const kind of files) {
    const file = { file_id: `${kind}-${id}`, file_unique_id: `uniq-${kind}-${id}` };
    if (r.chance(0.6)) file.file_name = safeWord(r) || `${kind}.bin`;
    const mime = r.pick(mimeTypes); if (mime !== null) file.mime_type = mime;
    if (r.chance(0.7)) file.file_size = r.int(0, 50_000_000);
    m[kind] = file;
  }
  if (files.length || m.photo) { if (r.chance(0.7)) m.caption = words(r); } else if (r.chance(0.9)) m.text = words(r);
  if (r.chance(0.2)) m.entities = [{ type: "bold", offset: 0, length: 1 }]; // Ignored.
  return { update_id: id, [kind]: m };
}
const contract = fn => { try { fn(); } catch (error) { assert.ok(error instanceof EmailContractError, `only contract errors may escape: ${error?.stack ?? error}`); return error; } return null; };
const { connection } = telegramContractFixture();

test("every generated update normalizes to a bounded envelope that reads back byte for byte", () => {
  const r = rng(0x5eed0001);
  let normalized = 0;
  for (let i = 1; i <= 400; i++) {
    const raw = update(r, 1000 + i), frozen = structuredClone(raw);
    const error = contract(() => normalizeTelegramUpdate(connection, raw));
    if (error) { assert.match(error.code, /^(invalid_telegram_message|invalid_telegram_attachment|invalid_channel_participant)$/, JSON.stringify(raw)); continue; }
    normalized++;
    const envelope = normalizeTelegramUpdate(connection, raw), kind = updateKind(raw), m = raw[kind];
    assert.deepEqual(raw, frozen, "normalization never mutates its input");
    assert.deepEqual(normalizeTelegramUpdate(connection, structuredClone(raw)), envelope, "normalization is deterministic");
    assert.deepEqual(readTelegramEnvelope(structuredClone(envelope)), envelope, "the envelope round-trips");
    assert.equal(envelope.message.kind, kind);
    assert.equal(envelope.message.id, `${m.chat.id}:${m.message_id}`);
    assert.equal(envelope.sourceId, telegramSourceId(connection, envelope.message.id));
    assert.equal(envelope.message.revision, String(raw.update_id));
    assert.equal(envelope.message.threadId, m.message_thread_id === undefined ? String(m.chat.id) : `${m.chat.id}/${m.message_thread_id}`);
    assert.equal(envelope.message.sentAt, new Date(m.date * 1000).toISOString());
    assert.equal(envelope.message.editedAt, m.edit_date === undefined ? null : new Date(m.edit_date * 1000).toISOString());
    assert.equal(envelope.message.replyTo, m.reply_to_message ? `${m.chat.id}:${m.reply_to_message.message_id}` : null);
    assert.equal(envelope.message.to.length, 1); assert.equal(envelope.message.to[0].id, String(m.chat.id));
    assert.equal(envelope.message.subject, null);
    assert.equal(envelope.body.format, "text");
    assert.equal(envelope.body.content, typeof m.text === "string" ? m.text : typeof m.caption === "string" ? m.caption : "");
    assert.ok(Buffer.byteLength(envelope.body.content) <= telegramLimits.bodyBytes);
    const expectedKinds = [...(Array.isArray(m.photo) && m.photo.length ? ["photo"] : []), ...fileKinds.filter(k => m[k] !== undefined)];
    assert.deepEqual(envelope.attachments.map(a => a.kind), expectedKinds, "one attachment per Bot API media field, photo first");
    for (const a of envelope.attachments) {
      const source = a.kind === "photo" ? m.photo.at(-1) : m[a.kind];
      assert.equal(a.id, source.file_id, "attachments are addressed by file_id");
      assert.equal(a.size, source.file_size ?? null);
      assert.equal(a.contentType, a.kind === "photo" ? null : source.mime_type ?? null, "MIME types pass through untouched or become null");
      assert.equal(a.name, a.kind === "photo" ? null : source.file_name ?? null);
    }
    const serialized = JSON.stringify(envelope);
    assert.doesNotMatch(serialized, /uniq-|language_code|entities|"width"/, "file_unique_id and Bot API noise never enter the envelope");
    if (m.from) { assert.equal(envelope.message.from.kind, m.from.is_bot ? "bot" : "user"); assert.equal(envelope.message.from.id, String(m.from.id)); }
    else assert.equal(envelope.message.from.kind, "channel");
    assert.equal(envelope.message.to[0].kind, { private: "chat", group: "group", supergroup: "group", channel: "channel" }[m.chat.type]);
  }
  assert.ok(normalized >= 300, `most generated updates should be valid, got ${normalized}`);
});

test("source identity depends only on account, bot and chat-qualified message id; the version follows content", () => {
  const r = rng(0x5eed0002);
  for (let i = 1; i <= 150; i++) {
    const a = update(r, 5000 + i), kind = updateKind(a);
    if (contract(() => normalizeTelegramUpdate(connection, a))) continue;
    const base = normalizeTelegramUpdate(connection, a);
    // Same message, different text, later update id: same source, new version.
    const edited = structuredClone(a); edited.update_id += 1;
    if (edited[kind].text === undefined) edited[kind].caption = (edited[kind].caption ?? "") + "!"; else edited[kind].text += "!";
    if (!contract(() => normalizeTelegramUpdate(connection, edited))) {
      const next = normalizeTelegramUpdate(connection, edited);
      assert.equal(next.sourceId, base.sourceId); assert.notEqual(next.sourceVersion, base.sourceVersion);
    }
    // Same text and message id in a different chat: a different source.
    const elsewhere = structuredClone(a); elsewhere[kind].chat = { ...elsewhere[kind].chat, id: elsewhere[kind].chat.id - 1 };
    if (elsewhere[kind].sender_chat) elsewhere[kind].sender_chat = { ...elsewhere[kind].chat };
    if (elsewhere[kind].reply_to_message) elsewhere[kind].reply_to_message = { ...elsewhere[kind].reply_to_message, chat: elsewhere[kind].chat };
    assert.notEqual(normalizeTelegramUpdate(connection, elsewhere).sourceId, base.sourceId);
    // Another account importing the same update sees a different source id.
    const other = { ...connection, accountId: "other-" + i };
    assert.notEqual(normalizeTelegramUpdate(other, a).sourceId, base.sourceId);
    assert.notEqual(normalizeTelegramUpdate(other, a).sourceVersion, base.sourceVersion, "the connection is part of the versioned content");
  }
});

test("random single-field corruption of an update or an envelope is always refused with a contract error", () => {
  const r = rng(0x5eed0003);
  const updateBreaks = [
    m => { m.message_id = String(m.message_id); }, m => { m.message_id = -m.message_id; }, m => { m.message_id = 1.5; }, m => { delete m.message_id; },
    m => { m.date = -1; }, m => { m.date = "1788948000"; }, m => { delete m.date; }, m => { m.edit_date = 2 ** 53; },
    m => { m.chat.type = "secret"; }, m => { delete m.chat.type; }, m => { m.chat.id = String(m.chat.id); }, m => { m.chat = null; }, m => { m.chat = [m.chat]; },
    m => { m.from = { id: "5" }; }, m => { m.from = { username: "x" }; }, m => { m.from = 5; },
    m => { m.text = "x".repeat(telegramLimits.bodyBytes + 1); }, m => { m.text = "\u{1f600}".repeat(telegramLimits.bodyBytes / 4 + 1); }, m => { m.text = "a b"; }, m => { m.text = "ab"; }, m => { m.text = "\ud800"; },
    m => { m.document = { file_id: "" }; }, m => { m.document = { file_id: 5 }; }, m => { m.document = null; }, m => { m.document = { file_id: "d", file_size: -1 }; }, m => { m.document = { file_id: "d", file_size: 1.5 }; },
    m => { m.document = { file_id: "d", mime_type: "x".repeat(241) }; }, m => { m.document = { file_id: "d", mime_type: "text/ plain" }; }, m => { m.document = { file_id: "d", mime_type: " " }; },
    m => { m.photo = [{ file_unique_id: "only" }]; }, m => { m.photo = [null]; }, m => { m.document = { file_id: "same" }; m.audio = { file_id: "same" }; },
    m => { m.reply_to_message = null; }, m => { m.reply_to_message = { message_id: "41" }; }, m => { m.message_thread_id = "7"; },
    m => { m.chat.title = "a\nb"; }, m => { m.chat.title = "t".repeat(1025); }, m => { m.from = { id: 1, username: "u".repeat(320) }; }, m => { m.from = { id: 1, first_name: "ab" }; }
  ];
  let refused = 0;
  for (let i = 1; i <= 300; i++) {
    const raw = update(r, 7000 + i);
    if (contract(() => normalizeTelegramUpdate(connection, raw))) continue;
    const broken = structuredClone(raw), kind = updateKind(broken);
    if (r.chance(0.1)) { broken.update_id = r.pick([1.5, "900001", null, 2 ** 53]); }
    else r.pick(updateBreaks)(broken[kind]);
    const error = contract(() => normalizeTelegramUpdate(connection, broken));
    assert.ok(error, `corruption must be refused: ${JSON.stringify(broken)}`);
    // Over-long or control-laden participant text surfaces the shared text helper's default code.
    assert.match(error.code, /^(invalid_telegram_message|invalid_telegram_update|invalid_telegram_attachment|duplicate_telegram_attachment|unsupported_telegram_update|unsupported_telegram_chat|invalid_channel_participant|invalid_channel_connection)$/);
    refused++;
  }
  assert.ok(refused >= 200, `expected many refusals, got ${refused}`);
  const envelopeBreaks = [
    e => { e.sourceVersion = "0".repeat(64); }, e => { e.sourceId = "telegram-" + "f".repeat(64); }, e => { e.contractVersion = 2; }, e => { e.channel = "email"; },
    e => { e.body.content += " "; }, e => { e.body.format = "html"; }, e => { e.message.subject = ""; }, e => { e.message.sentAt = e.message.sentAt.replace("Z", ""); },
    e => { e.message.sentAt = e.message.sentAt.replace(/^\d{4}-\d\d-\d\d/, "2026-02-30"); }, e => { e.message.sentAt = e.message.sentAt.replace(/\.\d+Z$/, ".12345678Z"); },
    e => { e.message.revision = String(Number(e.message.revision) + 1); }, e => { e.message.id = e.message.to[0].id + ":0"; }, e => { e.message.id = "1:2:3"; },
    e => { e.message.to = []; }, e => { e.message.to.push(e.message.to[0]); }, e => { e.message.from.kind = "mailbox"; }, e => { e.message.from.handle = "@" + "h".repeat(320); },
    e => { e.attachments.push({ id: "extra", kind: "photo", name: null, contentType: null, size: null }); }, e => { e.connection.revision = 2; }, e => { e.connection.accountId = "someone-else"; },
    e => { e.extra = true; }, e => { delete e.attachments; }, e => { e.message.editedAt = e.message.editedAt === null ? e.message.sentAt : null; }
  ];
  for (let i = 1; i <= 300; i++) {
    const raw = update(r, 8000 + i);
    if (contract(() => normalizeTelegramUpdate(connection, raw))) continue;
    const envelope = normalizeTelegramUpdate(connection, raw), tampered = structuredClone(envelope);
    r.pick(envelopeBreaks)(tampered);
    const error = contract(() => readTelegramEnvelope(tampered));
    assert.ok(error, `tampering must be refused: ${JSON.stringify(tampered)}`);
    assert.match(error.code, /^(telegram_version_mismatch|invalid_telegram_message|invalid_telegram_attachment|invalid_channel_participant|invalid_channel_connection|unsupported_channel|duplicate_telegram_attachment)$/);
  }
});

test("body text is accepted exactly when it is well formed, within the byte budget and free of forbidden control characters", () => {
  const r = rng(0x5eed0004), { updates } = telegramContractFixture();
  const pieces = [...alphabet, "", "", "", " ", "", "\ud83d", "\udc00", "x".repeat(4000), "\u{1f600}".repeat(1000)];
  for (let i = 0; i < 400; i++) {
    const content = Array.from({ length: r.int(0, 8) }, () => r.pick(pieces)).join("");
    const raw = structuredClone(updates[0]); raw.message.text = content;
    const expected = content.isWellFormed() && Buffer.byteLength(content) <= telegramLimits.bodyBytes && !/[ --]/.test(content);
    const error = contract(() => normalizeTelegramUpdate(connection, raw));
    assert.equal(error === null, expected, JSON.stringify(content.slice(0, 80)));
    if (!error) assert.equal(normalizeTelegramUpdate(connection, raw).body.content, content, "accepted text is preserved exactly, including newlines and tabs");
  }
});

test("getUpdates batches: strictly increasing ids, message kinds only, cursor is last id plus one", () => {
  const r = rng(0x5eed0005);
  for (let i = 0; i < 200; i++) {
    const limit = r.int(1, telegramLimits.updates), size = r.int(0, limit);
    let id = r.int(0, 1_000_000);
    const offset = r.chance(0.5) ? null : String(id), result = [];
    for (let n = 0; n < size; n++) {
      id += r.int(1, 3);
      result.push(r.chance(0.25) ? { update_id: id, callback_query: { id: "cb" } } : r.chance(0.1) ? { update_id: id, my_chat_member: {} } : update(r, id));
    }
    const page = telegramUpdates(connection, { ok: true, result }, { offset, limit });
    const messages = result.filter(u => updateKind(u));
    assert.deepEqual(page.changes.map(c => c.updateId), messages.map(u => u.update_id));
    assert.deepEqual(page.changes.map(c => c.messageId), messages.map(u => `${u[updateKind(u)].chat.id}:${u[updateKind(u)].message_id}`));
    assert.ok(page.changes.every(c => c.action === "hydrate"));
    assert.equal(page.cursor, result.length ? String(result.at(-1).update_id + 1) : offset ?? "0");
    assert.equal(page.complete, result.length < limit);
    if (result.length >= 2) {
      const j = r.int(1, result.length - 1), shuffled = structuredClone(result); [shuffled[j - 1], shuffled[j]] = [shuffled[j], shuffled[j - 1]];
      assert.throws(() => telegramUpdates(connection, { ok: true, result: shuffled }, { offset, limit }), { code: "invalid_telegram_updates" });
      const duplicated = structuredClone(result); duplicated.splice(j, 0, structuredClone(duplicated[j]));
      assert.throws(() => telegramUpdates(connection, { ok: true, result: duplicated }, { offset, limit }), { code: "invalid_telegram_updates" });
    }
    if (result.length && offset !== null) {
      const stale = structuredClone(result); stale[0].update_id = Number(offset) - 1;
      assert.throws(() => telegramUpdates(connection, { ok: true, result: stale }, { offset, limit }), { code: "invalid_telegram_updates" });
    }
    const overflow = [...result, ...Array.from({ length: limit - result.length + 1 }, (_, n) => ({ update_id: id + n + 1, callback_query: {} }))];
    assert.throws(() => telegramUpdates(connection, { ok: true, result: overflow }, { offset, limit }), { code: "invalid_telegram_updates" });
  }
});

test("arbitrary JSON values fed to the normalizers only ever raise contract errors", () => {
  const r = rng(0x5eed0006);
  const scalars = [null, true, false, 0, -1, 1.5, 2 ** 53, "", "x", "41", "-1001000000001:41", [], {}];
  const keys = ["update_id", "message", "edited_message", "channel_post", "chat", "from", "sender_chat", "id", "type", "message_id", "date", "edit_date", "text", "caption",
    "photo", "document", "audio", "video", "voice", "sticker", "animation", "video_note", "file_id", "file_size", "mime_type", "file_name", "reply_to_message", "message_thread_id",
    "connection", "body", "attachments", "sourceId", "sourceVersion", "contractVersion", "channel", "kind", "revision", "threadId", "sentAt", "editedAt", "to", "subject", "replyTo", "format", "content"];
  const junk = (depth = 0) => {
    if (depth > 3 || r.chance(0.4)) return r.pick(scalars);
    if (r.chance(0.3)) return Array.from({ length: r.int(0, 3) }, () => junk(depth + 1));
    return Object.fromEntries(Array.from({ length: r.int(0, 6) }, () => [r.pick(keys), junk(depth + 1)]));
  };
  const { updates } = telegramContractFixture();
  let accepted = 0;
  for (let i = 0; i < 1500; i++) {
    const value = junk();
    // Sometimes graft junk into an otherwise valid update so deeper branches are reached.
    let raw = value;
    if (r.chance(0.5)) { raw = structuredClone(r.pick(updates)); const kind = updateKind(raw); if (kind) raw[kind][r.pick(["chat", "from", "photo", "document", "reply_to_message", "text", "date", "message_id", "sender_chat"])] = value; }
    if (!contract(() => normalizeTelegramUpdate(connection, raw))) accepted++;
    contract(() => readTelegramEnvelope(raw));
    contract(() => telegramUpdates(connection, raw));
    contract(() => telegramUpdates(connection, { ok: true, result: Array.isArray(raw) ? raw : [raw] }));
    contract(() => telegramSourceId(connection, value));
    contract(() => normalizeTelegramUpdate(value, r.pick(updates)));
  }
  assert.ok(accepted < 400, "grafted junk is mostly refused");
});
