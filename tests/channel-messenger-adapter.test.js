// Invented Messenger webhook data. No real PSIDs, page ids, or secrets.
import test from "node:test";
import assert from "node:assert/strict";
import { ContractError } from "../server/channel-connection.mjs";
import { eventKind, normalizeMessengerEvent, normalizeMessengerWebhook, readMessengerEnvelope, messengerSourceId, RecordedMessengerPage, bind, scope } from "../server/channel-adapters/messenger.mjs";
import { readChannelEnvelope } from "../server/channel-adapters/index.mjs";

const connection = () => ({ accountId: "account-fixture", id: "messenger-fixture", revision: 1, channel: "messenger", provider: "messenger-api",
  externalId: "111222333444555", identity: { kind: "user", id: "111222333444555", handle: "", displayName: "page:111222333444555" },
  capabilities: { read: true, send: true, threads: false, edit: false } });
const PAGE = "111222333444555", USER = "999888777666555";
const textEvent = (over = {}) => { const { message: mOver, ...rest } = over;
  return { sender: { id: USER }, recipient: { id: PAGE }, timestamp: 1788948000000,
    message: { mid: "mid.fixture-1", text: "Hello from the fixture", ...mOver }, ...rest }; };
const webhook = events => ({ object: "page", entry: [{ id: PAGE, time: 1788948000000, messaging: events }] });

test("message, postback, read receipt, and optin events normalize", () => {
  const c = connection();
  const msg = normalizeMessengerEvent(c, PAGE, textEvent());
  assert.equal(msg.channel, "messenger"); assert.equal(msg.contractVersion, 1);
  assert.equal(msg.message.kind, "message");
  assert.equal(msg.message.id, PAGE + ":mid.fixture-1");
  assert.equal(msg.sourceId, messengerSourceId(c, PAGE + ":mid.fixture-1"));
  assert.match(msg.sourceId, /^messenger-[a-f0-9]{64}$/);
  assert.equal(msg.message.sentAt, "2026-09-09T10:00:00.000Z");
  assert.equal(msg.message.threadId, PAGE + "|" + USER);
  assert.deepEqual(msg.message.from, { kind: "user", id: USER, handle: "", displayName: "" });
  assert.deepEqual(msg.body, { format: "text", content: "Hello from the fixture" });
  const postback = normalizeMessengerEvent(c, PAGE, { sender: { id: USER }, recipient: { id: PAGE }, timestamp: 1788948060000,
    postback: { mid: "mid.fixture-2", title: "Yes please", payload: "CONFIRM_123" } });
  assert.equal(postback.message.kind, "postback");
  assert.equal(postback.message.revision, "CONFIRM_123", "tap payload rides the opaque revision slot");
  assert.equal(postback.body.content, "Yes please");
  const read = normalizeMessengerEvent(c, PAGE, { sender: { id: USER }, recipient: { id: PAGE }, timestamp: 1788948120000,
    read: { watermark: 1788948000000, seq: 42 } });
  assert.equal(read.message.kind, "read_receipt");
  assert.equal(read.body.content, "");
  assert.equal(read.message.id, PAGE + ":read:1788948000000");
  const optin = normalizeMessengerEvent(c, PAGE, { sender: { id: USER }, recipient: { id: PAGE }, timestamp: 1788948180000,
    optin: { ref: "PASS_THROUGH_PARAM" } });
  assert.equal(optin.message.kind, "optin");
  assert.equal(optin.message.revision, "PASS_THROUGH_PARAM");
  for (const envelope of [msg, postback, read, optin]) {
    assert.deepEqual(readMessengerEnvelope(envelope), envelope);
    assert.deepEqual(readChannelEnvelope(structuredClone(envelope)), envelope);
  }
});

test("quick_reply payload is preserved; unknown events are skipped, never imported", () => {
  const c = connection();
  const qr = normalizeMessengerEvent(c, PAGE, textEvent({ message: { mid: "mid.fixture-qr", quick_reply: { payload: "QR_YES" } } }));
  assert.equal(qr.message.revision, "QR_YES");
  assert.equal(eventKind({ message: { mid: "x" } }), "message");
  assert.equal(eventKind({ delivery: { mids: ["x"] } }), null, "delivery callbacks are not messages");
  assert.equal(eventKind({}), null);
  const { envelopes, skipped } = normalizeMessengerWebhook(c, webhook([textEvent(), { delivery: { mids: ["mid.x"] } }, textEvent({ message: { mid: "mid.fixture-3", text: "third" } })]));
  assert.equal(envelopes.length, 2);
  assert.equal(envelopes[1].body.content, "third");
  assert.equal(skipped.length, 1); assert.equal(skipped[0].page, PAGE);
});

test("malformed events and envelopes are rejected", () => {
  const c = connection(), good = textEvent();
  for (const change of [e => delete e.sender, e => e.sender = { id: "not-numeric" }, e => e.timestamp = -5,
    e => e.message = { text: "no mid" }, e => e.message = { mid: "x", text: "x".repeat(20000) }]) {
    const event = structuredClone(good); change(event);
    assert.throws(() => normalizeMessengerEvent(c, PAGE, event), ContractError);
  }
  assert.throws(() => normalizeMessengerEvent(c, "not-a-page", good), ContractError);
  assert.throws(() => normalizeMessengerWebhook(c, { object: "user", entry: [] }), ContractError);
  assert.throws(() => normalizeMessengerWebhook(c, { object: "page", entry: [{ id: PAGE }] }), ContractError);
  const envelope = normalizeMessengerEvent(c, PAGE, good);
  for (const change of [e => e.sourceVersion = "0".repeat(64), e => e.channel = "sms", e => e.message.kind = "edited",
    e => e.body.format = "html", e => e.extra = 1, e => e.message.from.kind = "person"]) {
    const copy = structuredClone(envelope); change(copy);
    assert.throws(() => readMessengerEnvelope(copy), ContractError);
  }
});

test("recorded page binds to the uniform driver interface", async () => {
  const c = connection(), events = [{ page: PAGE, event: textEvent() }, { page: PAGE, event: textEvent({ message: { mid: "mid.fixture-2", text: "two" } }) }];
  const reader = new RecordedMessengerPage({ connection: c, events });
  assert.equal(reader.kind, "messenger-api");
  assert.equal(scope(), "updates");
  const driver = bind({ reader, connection: c });
  assert.equal(driver.channel, "messenger"); assert.equal(driver.provider, "messenger-api");
  const page = await driver.changes({ cursor: null });
  assert.equal(page.changes.length, 2); assert.equal(page.cursor, "2"); assert.equal(page.complete, true);
  assert.deepEqual(await driver.hydrate("cursor:1"), events[1]);
  const normalized = driver.normalize(await driver.hydrate("cursor:1"));
  assert.equal(normalized.body.content, "two");
  assert.deepEqual(driver.normalizeWebhook(webhook([textEvent()])).envelopes.map(e => e.message.kind), ["message"]);
  const operationId = "op-1", envelope = { provider: "messenger-api", adapter: "messenger", previewVersion: "v1" };
  const receipt = await driver.submit({ operationId, envelope });
  assert.equal(receipt.outcome, "accepted");
  assert.deepEqual(await driver.lookup({ operationId }), receipt);
  assert.throws(() => bind({ reader: {}, connection: c }), ContractError);
});
