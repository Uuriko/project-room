// Invented data only. Secrets are fixture strings passed in per call.
import test from "node:test";
import assert from "node:assert/strict";
import { ContractError } from "../server/channel-connection.mjs";
import { classifySmsPayload, ingestSms, ingestSmsBatch, twilioSignature, verifyTwilioSignature } from "../server/sms-ingest.mjs";

const connection = () => ({ accountId: "account-fixture", id: "sms-fixture", revision: 1, channel: "sms", provider: "sms-gateway",
  externalId: "+15550001111", identity: { kind: "user", id: "+15550001111", handle: "+15550001111", displayName: "Fixture line" },
  capabilities: { read: true, send: true, threads: false, edit: false } });
const inbound = { MessageSid: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", From: "+15550002222", To: "+15550001111", Body: "Hello from the fixture", NumSegments: 1 };
const callback = { MessageSid: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", MessageStatus: "delivered", From: "+15550001111", To: "+15550002222" };

test("payloads classify and ingest into the right envelope kind", () => {
  assert.equal(classifySmsPayload(inbound), "message");
  assert.equal(classifySmsPayload(callback), "delivery_receipt");
  const c = connection();
  const msg = ingestSms(c, inbound);
  assert.equal(msg.channel, "sms"); assert.equal(msg.message.kind, "message");
  assert.equal(msg.body.content, "Hello from the fixture");
  const receipt = ingestSms(c, callback);
  assert.equal(receipt.message.kind, "delivery_receipt");
  assert.equal(receipt.message.revision, "delivered");
  assert.throws(() => classifySmsPayload({ MessageSid: "SMx", Body: "b", MessageStatus: "delivered" }), ContractError, "both shapes at once is ambiguous");
  assert.throws(() => classifySmsPayload({ MessageSid: "SMx" }), ContractError, "neither shape");
  assert.throws(() => ingestSms(c, { Body: "no sid" }), ContractError);
});

test("batch ingest keeps order and quarantines rejections with their index", () => {
  const { envelopes, rejected } = ingestSmsBatch(connection(), [inbound, { nope: true }, callback, { MessageSid: "SMx", Body: 42 }]);
  assert.equal(envelopes.length, 2);
  assert.equal(envelopes[0].message.kind, "message");
  assert.equal(envelopes[1].message.kind, "delivery_receipt");
  assert.deepEqual(rejected.map(r => r.index), [1, 3]);
  assert.ok(rejected.every(r => typeof r.code === "string"));
  assert.throws(() => ingestSmsBatch(connection(), "not-an-array"), ContractError);
});

test("twilio request signature verifies and rejects tampering", () => {
  const secret = "fixture-auth-token", url = "https://example.com/sms/webhook";
  const params = { From: "+15550002222", To: "+15550001111", Body: "Hello from the fixture" };
  // Pinned vector: HMAC-SHA1(url + sorted params) base64.
  assert.equal(twilioSignature(secret, url, params), "ueLyPa2ECteNdkAxy93rnMCom2c=");
  assert.equal(verifyTwilioSignature(secret, url, params, "ueLyPa2ECteNdkAxy93rnMCom2c="), true);
  assert.equal(verifyTwilioSignature(secret, url, { ...params, Body: "tampered" }, "ueLyPa2ECteNdkAxy93rnMCom2c="), false);
  assert.equal(verifyTwilioSignature("wrong-secret", url, params, "ueLyPa2ECteNdkAxy93rnMCom2c="), false);
  assert.equal(verifyTwilioSignature(secret, "https://example.com/other", params, "ueLyPa2ECteNdkAxy93rnMCom2c="), false);
  assert.equal(verifyTwilioSignature(secret, url, params, "AAAAAAAAAAAAAAAAAAAAAAAAAAAA"), false);
  assert.throws(() => twilioSignature("", url, params), ContractError);
  assert.throws(() => verifyTwilioSignature(secret, url, params, null), ContractError);
});
