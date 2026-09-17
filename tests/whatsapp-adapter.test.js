import test from "node:test";
import assert from "node:assert/strict";
import { bind, normalizeWhatsappPayload, normalizeWhatsappUpdate, qualifyWhatsappCursor, readEnvelope, readWhatsappEnvelope,
  RecordedWhatsAppCloud, whatsappLimits, whatsappSourceId, whatsappUpdates } from "../server/channel-adapters/whatsapp.mjs";
import { EmailContractError } from "../server/email-envelope.mjs";

// Invented Meta WhatsApp Cloud API webhook shapes. No access token, real
// business account, or real people: every id and phone number is fictional.
const NUMBER_ID = "109876543210987";
const DISPLAY_NUMBER = "15551234567";
const connection = { accountId: "account-fixture", id: "whatsapp-fixture", revision: 1, channel: "whatsapp", provider: "whatsapp-cloud",
  externalId: NUMBER_ID, identity: { kind: "bot", id: NUMBER_ID, handle: "", displayName: DISPLAY_NUMBER },
  capabilities: { read: true, send: false, threads: false, edit: false } };
const meta = (messages, contacts) => ({ messaging_product: "whatsapp",
  metadata: { display_phone_number: DISPLAY_NUMBER, phone_number_id: NUMBER_ID },
  ...(contacts === undefined ? {} : { contacts }), ...(messages === undefined ? {} : { messages }) });
function fixture() {
  const contacts = [
    { profile: { name: "Avery Quinn" }, wa_id: "15557654321" },
    { profile: { name: "Lee" }, wa_id: "15559876543" },
  ];
  const text1 = { from: "15557654321", id: "wamid.fixture0001", timestamp: "1788948000", type: "text",
    text: { body: "Shall we work on this together?\n\nPrivate budget: 4200." } };
  const text2 = { from: "15559876543", id: "wamid.fixture0002", timestamp: "1788948060", type: "text",
    context: { from: "15557654321", id: "wamid.fixture0001" }, text: { body: "Yes — sending the brief now." } };
  const text3 = { from: "15550001111", id: "wamid.fixture0003", timestamp: "1788948120", type: "text", text: { body: "No contact entry for me." } };
  const image = { from: "15557654321", id: "wamid.fixture0004", timestamp: "1788948180", type: "image",
    image: { mime_type: "image/jpeg", sha256: "e3b0c44298fc", id: "media-999" } };
  const audio = { from: "15559876543", id: "wamid.fixture0005", timestamp: "1788948240", type: "audio",
    audio: { mime_type: "audio/ogg", id: "media-1000" } };
  const statuses = { messaging_product: "whatsapp",
    metadata: { display_phone_number: DISPLAY_NUMBER, phone_number_id: NUMBER_ID },
    statuses: [{ id: "wamid.fixture0001", status: "delivered", timestamp: "1788948010", recipient_id: "15557654321" }] };
  const payloads = [
    { object: "whatsapp_business_account", entry: [{ id: "110022003300440", changes: [
      { value: meta([text1, text2, image], contacts), field: "messages" },
      { value: statuses, field: "messages" },
    ] }] },
    { object: "whatsapp_business_account", entry: [{ id: "110022003300440", changes: [
      { value: meta([text3, audio]), field: "messages" },
    ] }] },
  ];
  return { connection, payloads, contacts, text1, text2, text3, image, audio };
}

test("text messages normalize into one bounded envelope; contacts map to display names; non-text skips with reasons", () => {
  const f = fixture();
  const { envelopes, skipped } = normalizeWhatsappPayload(f.connection, f.payloads[0]);
  assert.equal(envelopes.length, 2);
  assert.deepEqual(skipped, [{ messageId: NUMBER_ID + ":wamid.fixture0004", reason: "unsupported_whatsapp_message_type:image" }],
    "status-only changes are ignored; the image is skipped with its type");
  const first = envelopes[0];
  assert.equal(first.channel, "whatsapp"); assert.equal(first.contractVersion, 1);
  assert.equal(first.sourceId, whatsappSourceId(f.connection, NUMBER_ID + ":wamid.fixture0001"));
  assert.match(first.sourceId, /^whatsapp-[a-f0-9]{64}$/);
  assert.deepEqual(first.message, { id: NUMBER_ID + ":wamid.fixture0001", revision: "1788948000",
    threadId: NUMBER_ID + ":15557654321", kind: "message", sentAt: "2026-09-09T10:00:00.000Z", editedAt: null,
    from: { kind: "user", id: "15557654321", handle: "", displayName: "Avery Quinn" },
    to: [{ kind: "bot", id: NUMBER_ID, handle: "", displayName: DISPLAY_NUMBER }], subject: null, replyTo: null });
  assert.deepEqual(first.body, { format: "text", content: "Shall we work on this together?\n\nPrivate budget: 4200." });
  assert.deepEqual(first.attachments, [], "this slice carries no attachments");
  const second = envelopes[1];
  assert.equal(second.message.replyTo, NUMBER_ID + ":wamid.fixture0001", "message context maps to replyTo");
  assert.equal(second.message.from.displayName, "Lee");
  assert.equal(second.message.threadId, NUMBER_ID + ":15559876543", "the thread is the business-number/sender conversation");
  const next = normalizeWhatsappPayload(f.connection, f.payloads[1]);
  assert.equal(next.envelopes.length, 1);
  assert.equal(next.envelopes[0].message.from.displayName, "", "senders missing from contacts get an empty display name");
  assert.deepEqual(next.skipped, [{ messageId: NUMBER_ID + ":wamid.fixture0005", reason: "unsupported_whatsapp_message_type:audio" }]);
  for (const envelope of [...envelopes, ...next.envelopes]) {
    assert.deepEqual(readWhatsappEnvelope(structuredClone(envelope)), envelope);
    assert.deepEqual(readEnvelope(structuredClone(envelope)), envelope);
  }
  const other = { ...f.connection, accountId: "someone-else" };
  assert.notEqual(normalizeWhatsappPayload(other, f.payloads[0]).envelopes[0].sourceId, first.sourceId, "source identity is account scoped");
});

test("direct normalization of a non-text item refuses with a contract error, never a crash", () => {
  const f = fixture();
  const value = f.payloads[0].entry[0].changes[0].value;
  assert.throws(() => normalizeWhatsappUpdate(f.connection, { value, message: f.image }), { code: "unsupported_whatsapp_message" });
  assert.throws(() => normalizeWhatsappUpdate(f.connection, { value, message: f.audio }), { code: "unsupported_whatsapp_message" });
  assert.throws(() => normalizeWhatsappUpdate(f.connection, { value, message: { ...f.image, type: "sticker" } }),
    { code: "unsupported_whatsapp_message" }, "unknown future types refuse the same way");
});

test("malformed webhook payloads are contract errors", () => {
  const f = fixture();
  const bad = mutate => { const payload = structuredClone(f.payloads[0]); mutate(payload); return payload; };
  const cases = [
    ["entry must be an array", p => { p.entry = {}; }, "invalid_whatsapp_update"],
    ["object must be whatsapp_business_account", p => { p.object = "instagram"; }, "invalid_whatsapp_update"],
    ["changes must be an array", p => { p.entry[0].changes = {}; }, "invalid_whatsapp_update"],
    ["messages must be an array", p => { p.entry[0].changes[0].value.messages = {}; }, "invalid_whatsapp_update"],
    ["message id must be a string", p => { p.entry[0].changes[0].value.messages[0].id = 42; }, "invalid_whatsapp_update"],
    ["message type must be a string", p => { p.entry[0].changes[0].value.messages[0].type = null; }, "invalid_whatsapp_update"],
    ["timestamp must be a digit string", p => { p.entry[0].changes[0].value.messages[0].timestamp = 1788948000; }, "invalid_whatsapp_update"],
    ["negative timestamps refuse", p => { p.entry[0].changes[0].value.messages[0].timestamp = "-1"; }, "invalid_whatsapp_update"],
    ["text body must be a string", p => { p.entry[0].changes[0].value.messages[0].text.body = 42; }, "unsupported_whatsapp_message"],
    ["body over the byte cap refuses", p => { p.entry[0].changes[0].value.messages[0].text.body = "x".repeat(whatsappLimits.bodyBytes + 1); }, "invalid_whatsapp_message"],
    ["control characters refuse", p => { p.entry[0].changes[0].value.messages[0].text.body = "a\u000bb"; }, "invalid_whatsapp_message"],
    ["lone surrogates refuse", p => { p.entry[0].changes[0].value.messages[0].text.body = "a\ud800b"; }, "invalid_whatsapp_message"],
    ["non-whatsapp products are unsupported", p => { p.entry[0].changes[0].value.messaging_product = "messenger"; }, "unsupported_whatsapp_update"],
    ["metadata is required", p => { delete p.entry[0].changes[0].value.metadata; }, "invalid_whatsapp_update"],
    ["phone_number_id must be digits", p => { p.entry[0].changes[0].value.metadata.phone_number_id = "abc"; }, "invalid_whatsapp_update"],
    ["sender must be digits", p => { p.entry[0].changes[0].value.messages[0].from = "+15557654321"; }, "invalid_whatsapp_update"],
    ["malformed contacts refuse", p => { p.entry[0].changes[0].value.contacts = [{ wa_id: "15557654321", profile: { name: 42 } }]; }, "invalid_whatsapp_update"],
    ["malformed reply context refuses", p => { p.entry[0].changes[0].value.messages[1].context = { id: 7 }; }, "invalid_whatsapp_update"],
  ];
  for (const [label, mutate, code] of cases) {
    assert.throws(() => normalizeWhatsappPayload(f.connection, bad(mutate)), { code }, label);
    assert.throws(() => normalizeWhatsappPayload(f.connection, bad(mutate)), EmailContractError, label);
  }
  const huge = structuredClone(f.payloads[0]);
  huge.entry[0].changes[0].value.messages[0].text.body = "x".repeat(whatsappLimits.inputBytes);
  assert.throws(() => normalizeWhatsappPayload(f.connection, huge), { code: "whatsapp_input_limit" });
  assert.deepEqual(whatsappLimits, { bodyBytes: 16384, attachments: 0, updates: 100, inputBytes: 1048576 });
});

test("envelope tampering is refused on read", () => {
  const f = fixture();
  const { envelopes } = normalizeWhatsappPayload(f.connection, f.payloads[0]);
  for (const mutate of [e => { e.sourceVersion = "0".repeat(64); }, e => { e.sourceId = "whatsapp-" + "f".repeat(64); },
    e => { e.contractVersion = 2; }, e => { e.channel = "telegram"; }, e => { e.body.content += " "; }, e => { e.body.format = "html"; },
    e => { e.message.subject = ""; }, e => { e.message.editedAt = e.message.sentAt; }, e => { e.message.id = "wamid.fixture0001"; },
    e => { e.message.to = []; }, e => { e.message.to.push(e.message.to[0]); }, e => { e.message.from.kind = "mailbox"; },
    e => { e.attachments.push({ id: "x", kind: "photo", name: null, contentType: null, size: null }); },
    e => { e.connection.revision = 2; }, e => { e.connection.accountId = "someone-else"; },
    e => { e.extra = true; }, e => { delete e.attachments; }, e => { e.connection.provider = "telegram-bot"; }]) {
    const tampered = structuredClone(envelopes[0]); mutate(tampered);
    assert.throws(() => readWhatsappEnvelope(tampered), EmailContractError, JSON.stringify(mutate));
  }
});

test("a recorded cloud API pages webhook deliveries by offset; the bound adapter hydrates raw items and refuses outbound", async () => {
  const f = fixture();
  const reader = new RecordedWhatsAppCloud({ connection: f.connection, payloads: f.payloads, limit: 1 });
  assert.deepEqual(reader.connection, f.connection);
  assert.equal(reader.kind, "whatsapp-cloud");
  const first = await reader.getUpdates({ offset: null });
  assert.equal(first.ok, true); assert.equal(first.result.length, 1);
  const page = whatsappUpdates(f.connection, first, { offset: null, limit: 1 });
  assert.equal(page.contractVersion, 1);
  assert.deepEqual(page.connection, f.connection);
  assert.deepEqual(page.changes.map(c => c.messageId), [NUMBER_ID + ":wamid.fixture0001", NUMBER_ID + ":wamid.fixture0002"]);
  assert.ok(page.changes.every(c => c.action === "hydrate"));
  assert.deepEqual(page.skipped, [{ messageId: NUMBER_ID + ":wamid.fixture0004", reason: "unsupported_whatsapp_message_type:image" }]);
  assert.equal(page.cursor, "1"); assert.equal(page.complete, false);
  const second = whatsappUpdates(f.connection, await reader.getUpdates({ offset: page.cursor }), { offset: page.cursor, limit: 1 });
  assert.deepEqual(second.changes.map(c => c.messageId), [NUMBER_ID + ":wamid.fixture0003"]);
  assert.deepEqual(second.skipped, [{ messageId: NUMBER_ID + ":wamid.fixture0005", reason: "unsupported_whatsapp_message_type:audio" }]);
  assert.equal(second.cursor, "2"); assert.equal(second.complete, false);
  const third = whatsappUpdates(f.connection, await reader.getUpdates({ offset: "2" }), { offset: "2", limit: 1 });
  assert.deepEqual(third.changes, []); assert.deepEqual(third.skipped, []);
  assert.equal(third.cursor, "2"); assert.equal(third.complete, true);
  assert.equal(qualifyWhatsappCursor("42"), "42");
  assert.throws(() => whatsappUpdates(f.connection, { ok: false, result: [] }), { code: "invalid_whatsapp_updates" });
  assert.throws(() => whatsappUpdates(f.connection, first, { offset: "abc" }), { code: "invalid_whatsapp_cursor" });
  assert.throws(() => qualifyWhatsappCursor("4x"), { code: "invalid_whatsapp_cursor" });
  assert.throws(() => whatsappUpdates(f.connection, { ok: true, result: f.payloads }, { offset: null, limit: 1 }), { code: "invalid_whatsapp_updates" });
  assert.throws(() => new RecordedWhatsAppCloud({ connection: f.connection, payloads: "nope" }), { code: "invalid_whatsapp_recording" });
  assert.throws(() => new RecordedWhatsAppCloud({ connection: f.connection, payloads: f.payloads, limit: 0 }), { code: "invalid_whatsapp_recording" });
  assert.throws(() => new RecordedWhatsAppCloud({ connection: f.connection, payloads: f.payloads, limit: 101 }), { code: "invalid_whatsapp_recording" });
  assert.throws(() => new RecordedWhatsAppCloud({ connection: { ...f.connection, provider: "telegram-bot" }, payloads: f.payloads }), EmailContractError);
  const adapter = bind({ reader: new RecordedWhatsAppCloud({ connection: f.connection, payloads: f.payloads }), connection: f.connection });
  assert.deepEqual([adapter.channel, adapter.provider, adapter.scope()], ["whatsapp", "whatsapp-cloud", "updates"]);
  for (const key of ["normalize", "changes", "hydrate", "submit", "lookup", "sourceId"]) assert.equal(typeof adapter[key], "function", key);
  const all = await adapter.changes({ cursor: null });
  assert.equal(all.complete, true); assert.equal(all.cursor, "2"); assert.equal(all.changes.length, 3);
  assert.equal(all.skipped.length, 2, "both non-text messages surface as skips across pages");
  const raw = await adapter.hydrate(NUMBER_ID + ":wamid.fixture0001");
  assert.deepEqual(Object.keys(raw).sort(), ["message", "value"], "hydrate returns the raw webhook item");
  assert.equal(raw.message.id, "wamid.fixture0001");
  const envelope = adapter.normalize(raw);
  assert.equal(envelope.message.kind, "message");
  assert.equal(envelope.sourceId, whatsappSourceId(f.connection, NUMBER_ID + ":wamid.fixture0001"));
  assert.equal(await adapter.hydrate(NUMBER_ID + ":wamid.missing"), null);
  assert.equal(adapter.sourceId(NUMBER_ID + ":wamid.fixture0001"), whatsappSourceId(f.connection, NUMBER_ID + ":wamid.fixture0001"));
  await assert.rejects(adapter.submit({ operationId: "op-1" }), { code: "channel_sending_unavailable" });
  await assert.rejects(adapter.lookup({ operationId: "op-1" }), { code: "channel_sending_unavailable" });
  assert.throws(() => bind({ reader: {}, connection: f.connection }), { code: "whatsapp_fixture_reader_required" });
});

test("out-of-range WhatsApp timestamps are contract errors, never a RangeError", () => {
  const f = fixture();
  const value = f.payloads[0].entry[0].changes[0].value;
  const item = timestamp => ({ value, message: { ...f.text1, timestamp } });
  assert.equal(normalizeWhatsappUpdate(f.connection, item("253402300799")).message.sentAt, "9999-12-31T23:59:59.000Z");
  for (const timestamp of ["253402300800", "9999999999999999", "-1", "1.5", "", " 1788948000", 1788948000])
    assert.throws(() => normalizeWhatsappUpdate(f.connection, item(timestamp)), { code: "invalid_whatsapp_update" }, String(timestamp));
});
