// Invented data only. No real numbers, PSIDs, or credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { ContractError } from "../server/channel-connection.mjs";
import { analyzeSmsBody, segmentSms, buildSmsSend } from "../server/sms-outbound.mjs";
import { buildMessengerSend, messengerSendLimits } from "../server/messenger-outbound.mjs";

test("sms segmentation accounts GSM-7 vs UCS-2 and the 160/153 + 70/67 budgets", () => {
  assert.deepEqual(analyzeSmsBody("hello"), { encoding: "gsm7", units: 5, segments: 1, perSegment: 160 });
  assert.deepEqual(analyzeSmsBody("x".repeat(160)), { encoding: "gsm7", units: 160, segments: 1, perSegment: 160 });
  const two = analyzeSmsBody("x".repeat(161));
  assert.equal(two.segments, 2); assert.equal(two.perSegment, 153);
  const three = analyzeSmsBody("x".repeat(307));
  assert.equal(three.segments, 3);
  const emoji = analyzeSmsBody("hi 👋");
  assert.equal(emoji.encoding, "ucs2"); assert.equal(emoji.units, 5); assert.equal(emoji.segments, 1); assert.equal(emoji.perSegment, 70);
  const ucsMulti = analyzeSmsBody("👋".repeat(36));
  assert.equal(ucsMulti.units, 72); assert.equal(ucsMulti.segments, 2); assert.equal(ucsMulti.perSegment, 67);
  const ext = analyzeSmsBody("{}"); // GSM-7 extension chars cost 2 septets each
  assert.deepEqual(ext, { encoding: "gsm7", units: 4, segments: 1, perSegment: 160 });
  assert.equal(analyzeSmsBody("x".repeat(1531)).segments, 11, "accounting reports; the send path refuses >10");
  assert.throws(() => segmentSms("x".repeat(1531)), ContractError, "more than 10 segments is refused");
  assert.throws(() => analyzeSmsBody(42), ContractError);
});

test("segmentSms splits without breaking extension pairs or surrogate pairs", () => {
  const { encoding, segments } = segmentSms("x".repeat(160) + "y".repeat(10));
  assert.equal(encoding, "gsm7"); assert.equal(segments.length, 2);
  assert.equal(segments[0].length, 153); assert.equal(segments[1].length, 17);
  assert.equal(segments.join(""), "x".repeat(160) + "y".repeat(10), "split is lossless");
  const emoji = segmentSms("👋".repeat(40));
  assert.equal(emoji.segments.length, 2);
  assert.ok(emoji.segments.every(s => !/\uFFFD/.test(s)), "no broken surrogates");
  assert.equal(emoji.segments.join(""), "👋".repeat(40));
  const ext = segmentSms("{".repeat(80) + "x"); // 161 septets -> 2 segments
  assert.equal(ext.segments.length, 2);
  assert.equal(ext.segments.join(""), "{".repeat(80) + "x", "split is lossless");
  const septets = s => [...s].reduce((n, ch) => n + ("^{}\\[~]|€".includes(ch) ? 2 : 1), 0);
  assert.ok(ext.segments.every(s => septets(s) <= 153), "every segment fits the concatenated budget");
});

test("buildSmsSend produces a frozen provider payload", () => {
  const payload = buildSmsSend({ to: "+15550002222", from: "+15550001111", body: "Hello from the fixture", callbackUrl: "https://example.com/sms/status" });
  assert.deepEqual(payload, { to: "+15550002222", from: "+15550001111", body: "Hello from the fixture",
    encoding: "gsm7", segmentCount: 1, segments: ["Hello from the fixture"], callbackUrl: "https://example.com/sms/status" });
  assert.ok(Object.isFrozen(payload) && Object.isFrozen(payload.segments));
  const multi = buildSmsSend({ to: "+15550002222", from: "+15550001111", body: "x".repeat(200) });
  assert.equal(multi.segmentCount, 2); assert.equal(multi.callbackUrl, null);
  for (const bad of [() => buildSmsSend({ to: "555", from: "+15550001111", body: "hi" }),
    () => buildSmsSend({ to: "+15550002222", from: "+15550001111", body: "" }),
    () => buildSmsSend({ to: "+15550002222", from: "+15550001111", body: "x".repeat(1531) }),
    () => buildSmsSend({ to: "+15550002222", from: "+15550001111", body: "hi", callbackUrl: "http://insecure.example.com" })]) {
    assert.throws(bad, ContractError);
  }
});

test("buildMessengerSend builds text payloads with optional quick replies", () => {
  const simple = buildMessengerSend({ recipientId: "999888777666555", text: "Hello from the fixture" });
  assert.deepEqual(simple, { recipient: { id: "999888777666555" }, messaging_type: "RESPONSE",
    message: { text: "Hello from the fixture" } });
  assert.ok(Object.isFrozen(simple) && Object.isFrozen(simple.recipient) && Object.isFrozen(simple.message));
  const qr = buildMessengerSend({ recipientId: "999888777666555", text: "Pick one",
    quickReplies: [{ title: "Yes", payload: "QR_YES" }, { title: "No", payload: "QR_NO" }], messagingType: "UPDATE" });
  assert.deepEqual(qr.message.quick_replies, [{ content_type: "text", title: "Yes", payload: "QR_YES" }, { content_type: "text", title: "No", payload: "QR_NO" }]);
  assert.equal(qr.messaging_type, "UPDATE");
  assert.equal(messengerSendLimits.quickReplies, 13);
  for (const bad of [() => buildMessengerSend({ recipientId: "not-a-psid", text: "hi" }),
    () => buildMessengerSend({ recipientId: "999888777666555", text: "   " }),
    () => buildMessengerSend({ recipientId: "999888777666555", text: "x".repeat(2001) }),
    () => buildMessengerSend({ recipientId: "999888777666555", text: "hi", quickReplies: Array.from({ length: 14 }, (_, i) => ({ title: "t" + i, payload: "p" + i })) }),
    () => buildMessengerSend({ recipientId: "999888777666555", text: "hi", quickReplies: [{ title: "x".repeat(21), payload: "p" }] }),
    () => buildMessengerSend({ recipientId: "999888777666555", text: "hi", quickReplies: [{ title: "t" }] }),
    () => buildMessengerSend({ recipientId: "999888777666555", text: "hi", messagingType: "BOGUS" })]) {
    assert.throws(bad, ContractError);
  }
});
