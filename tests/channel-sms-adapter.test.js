// Invented Twilio-shaped data. No real numbers, Sids, or credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { ContractError } from "../server/channel-connection.mjs";
import { normalizeSmsStatusCallback, normalizeSmsWebhook, readSmsEnvelope, smsSourceId, concatenationInfo, RecordedSmsGateway, bind, scope } from "../server/channel-adapters/sms.mjs";
import { readChannelEnvelope } from "../server/channel-adapters/index.mjs";

const connection = () => ({ accountId: "account-fixture", id: "sms-fixture", revision: 1, channel: "sms", provider: "sms-gateway",
  externalId: "+15550001111", identity: { kind: "user", id: "+15550001111", handle: "+15550001111", displayName: "Fixture line" },
  capabilities: { read: true, send: true, threads: false, edit: false } });
const inbound = (over = {}) => ({ MessageSid: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", From: "+15550002222", To: "+15550001111",
  Body: "Hello from the fixture", NumSegments: 1, ...over });

test("inbound webhook normalizes into one bounded envelope", () => {
  const envelope = normalizeSmsWebhook(connection(), inbound());
  assert.equal(envelope.channel, "sms"); assert.equal(envelope.contractVersion, 1);
  assert.equal(envelope.sourceId, smsSourceId(connection(), "+15550001111:SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  assert.match(envelope.sourceId, /^sms-[a-f0-9]{64}$/);
  assert.deepEqual(envelope.message, { id: "+15550001111:SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", revision: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    threadId: "+15550001111|+15550002222", kind: "message", sentAt: null, editedAt: null,
    from: { kind: "user", id: "+15550002222", handle: "+15550002222", displayName: "+15550002222" },
    to: [{ kind: "user", id: "+15550001111", handle: "+15550001111", displayName: "+15550001111" }], subject: null, replyTo: null });
  assert.deepEqual(envelope.body, { format: "text", content: "Hello from the fixture" });
  assert.deepEqual(envelope.attachments, []);
  assert.deepEqual(readSmsEnvelope(envelope), envelope);
  assert.deepEqual(readChannelEnvelope(structuredClone(envelope)), envelope);
  const other = { ...connection(), accountId: "someone-else" };
  assert.notEqual(normalizeSmsWebhook(other, inbound()).sourceId, envelope.sourceId, "source identity is account scoped");
});

test("concatenation metadata is reported; multipart bodies stay one envelope", () => {
  assert.deepEqual(concatenationInfo(inbound()), { segments: 1, multipart: false });
  assert.deepEqual(concatenationInfo(inbound({ NumSegments: 3 })), { segments: 3, multipart: true });
  assert.deepEqual(concatenationInfo(inbound({ NumSegments: undefined })), { segments: 1, multipart: false });
  const envelope = normalizeSmsWebhook(connection(), inbound({ NumSegments: 3, Body: "stitched body" }));
  assert.equal(envelope.body.content, "stitched body");
  assert.throws(() => concatenationInfo(inbound({ NumSegments: 0 })), ContractError);
  assert.throws(() => concatenationInfo(inbound({ NumSegments: 256 })), ContractError);
});

test("delivery status callbacks normalize as delivery_receipt envelopes", () => {
  const delivered = normalizeSmsStatusCallback(connection(), { MessageSid: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    MessageStatus: "delivered", From: "+15550001111", To: "+15550003333" });
  assert.equal(delivered.message.kind, "delivery_receipt");
  assert.equal(delivered.message.revision, "delivered");
  assert.equal(delivered.body.content, "");
  assert.match(delivered.message.id, /:receipt$/);
  assert.deepEqual(readSmsEnvelope(delivered), delivered);
  const failed = normalizeSmsStatusCallback(connection(), { MessageSid: "SMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    MessageStatus: "failed", ErrorCode: 30007, From: "+15550001111", To: "+15550003333" });
  assert.equal(failed.message.revision, "failed#30007");
  assert.notEqual(failed.sourceId, delivered.sourceId);
  for (const status of ["queued", "sent", "undelivered"]) {
    const e = normalizeSmsStatusCallback(connection(), { MessageSid: "SMcccccccccccccccccccccccccccccccc",
      MessageStatus: status, From: "+15550001111", To: "+15550003333" });
    assert.equal(e.message.revision, status);
  }
  assert.throws(() => normalizeSmsStatusCallback(connection(), { MessageSid: "SMdddddddddddddddddddddddddddddddd",
    MessageStatus: "read", From: "+15550001111", To: "+15550003333" }), ContractError);
});

test("malformed payloads and envelopes are rejected", () => {
  const c = connection(), good = inbound();
  for (const change of [p => delete p.MessageSid, p => p.From = "not-a-phone", p => p.To = "+15550001111x",
    p => p.MessageSid = "SM with spaces", p => p.Body = "x".repeat(5000)]) {
    const payload = structuredClone(good); change(payload);
    assert.throws(() => normalizeSmsWebhook(c, payload), ContractError);
  }
  assert.throws(() => normalizeSmsWebhook({ ...c, provider: "telegram-bot" }, good), ContractError);
  const envelope = normalizeSmsWebhook(c, good);
  for (const change of [e => e.sourceVersion = "0".repeat(64), e => e.channel = "email", e => e.message.kind = "edited",
    e => e.body.format = "html", e => e.extra = 1, e => e.message.to.push(e.message.to[0])]) {
    const copy = structuredClone(envelope); change(copy);
    assert.throws(() => readSmsEnvelope(copy), ContractError);
  }
});

test("recorded gateway binds to the uniform driver interface", async () => {
  const c = connection(), reader = new RecordedSmsGateway({ connection: c, inbound: [inbound(), inbound({ MessageSid: "SMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Body: "second" })] });
  assert.deepEqual(reader.connection, c);
  assert.equal(reader.kind, "sms-gateway");
  assert.equal(scope(), "updates");
  const driver = bind({ reader, connection: c });
  assert.equal(driver.channel, "sms"); assert.equal(driver.provider, "sms-gateway");
  const page = await driver.changes({ cursor: null });
  assert.equal(page.changes.length, 2); assert.equal(page.cursor, "2"); assert.equal(page.complete, true);
  assert.deepEqual(await driver.hydrate("cursor:0"), reader.inbound()[0]);
  assert.equal(await driver.hydrate("cursor:9"), null);
  const normalized = driver.normalize(await driver.hydrate("cursor:1"));
  assert.equal(normalized.body.content, "second");
  const operationId = "op-1", envelope = { provider: "sms-gateway", adapter: "sms", previewVersion: "v1" };
  const receipt = await driver.submit({ operationId, envelope });
  assert.equal(receipt.outcome, "accepted"); assert.equal(receipt.operationId, operationId);
  assert.deepEqual(await driver.lookup({ operationId }), receipt);
  assert.equal(await driver.lookup({ operationId: "missing" }), null);
  assert.throws(() => bind({ reader: {}, connection: c }), ContractError);
  reader.mode = "rejected";
  const rej = await driver.submit({ operationId: "op-2", envelope });
  assert.equal(rej.outcome, "rejected"); assert.equal(rej.providerId, null);
});
