// Invented data only. The app secret is a fixture string passed in per call.
import test from "node:test";
import assert from "node:assert/strict";
import { ContractError } from "../server/channel-connection.mjs";
import { ingestMessenger, ingestMessengerBatch, messengerSignature, verifyMessengerSignature } from "../server/messenger-ingest.mjs";

const connection = () => ({ accountId: "account-fixture", id: "messenger-fixture", revision: 1, channel: "messenger", provider: "messenger-api",
  externalId: "111222333444555", identity: { kind: "user", id: "111222333444555", handle: "", displayName: "page:111222333444555" },
  capabilities: { read: true, send: true, threads: false, edit: false } });
const PAGE = "111222333444555", USER = "999888777666555";
const textEvent = mid => ({ sender: { id: USER }, recipient: { id: PAGE }, timestamp: 1788948000000, message: { mid, text: "Hello from the fixture" } });
const body = events => ({ object: "page", entry: [{ id: PAGE, time: 1788948000000, messaging: events }] });

test("webhook bodies ingest into envelopes; unknown events are reported, not imported", () => {
  const { envelopes, skipped } = ingestMessenger(connection(), body([textEvent("mid.fixture-1"), { delivery: { mids: ["mid.x"] } }]));
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].channel, "messenger");
  assert.equal(envelopes[0].body.content, "Hello from the fixture");
  assert.equal(skipped.length, 1); assert.equal(skipped[0].page, PAGE);
  const postback = ingestMessenger(connection(), body([{ sender: { id: USER }, recipient: { id: PAGE }, timestamp: 1788948060000,
    postback: { mid: "mid.fixture-2", title: "Yes please", payload: "CONFIRM_123" } }]));
  assert.equal(postback.envelopes[0].message.kind, "postback");
  assert.throws(() => ingestMessenger(connection(), { object: "user", entry: [] }), ContractError);
});

test("batch ingest keeps order across bodies and quarantines rejections", () => {
  const { envelopes, skipped, rejected } = ingestMessengerBatch(connection(),
    [body([textEvent("mid.fixture-1")]), { object: "nope" }, body([{ sender: { id: USER }, recipient: { id: PAGE }, timestamp: 1, read: { watermark: 5 } }])]);
  assert.equal(envelopes.length, 2);
  assert.equal(envelopes[1].message.kind, "read_receipt");
  assert.deepEqual(rejected.map(r => r.index), [1]);
  assert.deepEqual(skipped, []);
  assert.throws(() => ingestMessengerBatch(connection(), "not-an-array"), ContractError);
});

test("x-hub-signature-256 verifies and rejects tampering", () => {
  const secret = "fixture-app-secret", raw = "{\"object\":\"page\"}";
  // Pinned vector: "sha256=" + hex(HMAC-SHA256(secret, raw)).
  assert.equal(messengerSignature(secret, raw), "sha256=696837f9fafc948015a5ceb9758cc8bdbeceb6336b36eceb9fd8d4d543a82c41");
  assert.equal(verifyMessengerSignature(secret, raw, "sha256=696837f9fafc948015a5ceb9758cc8bdbeceb6336b36eceb9fd8d4d543a82c41"), true);
  assert.equal(verifyMessengerSignature(secret, "{\"object\":\"tampered\"}", "sha256=696837f9fafc948015a5ceb9758cc8bdbeceb6336b36eceb9fd8d4d543a82c41"), false);
  assert.equal(verifyMessengerSignature("wrong-secret", raw, "sha256=696837f9fafc948015a5ceb9758cc8bdbeceb6336b36eceb9fd8d4d543a82c41"), false);
  assert.equal(verifyMessengerSignature(secret, raw, "sha256=" + "0".repeat(64)), false);
  assert.equal(verifyMessengerSignature(secret, raw, "not-a-signature"), false);
  assert.throws(() => messengerSignature("", raw), ContractError);
  assert.throws(() => verifyMessengerSignature(secret, raw, null), ContractError);
});
