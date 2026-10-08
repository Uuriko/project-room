// Inbox send UI pure contracts: the direct-send honesty copy, the
// channel-sends receipt validator, the send-capability gate, and the pending
// reply-review storage validator. The installers themselves are DOM-bound and
// stay owned by the browser checks; these guard the decisions those
// installers make, at the boundary where a wrong answer misleads the owner.
import test from "node:test";
import assert from "node:assert/strict";
import {
  directSendErrorText,
  validDirectSendResponse,
  isSendableDraft,
  validReplyReviewPending,
} from "../src/inbox-send-ui.js";

// --- directSendErrorText: every failure line carries the no-send guarantee ---

test("directSendErrorText maps each known error code to its honest line", () => {
  assert.equal(directSendErrorText("gmail_not_connected"), "Gmail isn’t connected for sending. Nothing was sent.");
  assert.equal(directSendErrorText("telegram_not_connected"), "Telegram isn’t configured here. Nothing was sent.");
  assert.equal(directSendErrorText("telegram_send_rejected"), "Telegram refused the message. Nothing was sent.");
  assert.equal(directSendErrorText("telegram_unavailable"), "Telegram is unreachable right now. Nothing was confirmed sent.");
  assert.equal(directSendErrorText("gmail_unavailable"), "Gmail is unreachable right now. Nothing was confirmed sent.");
  assert.equal(directSendErrorText("invalid_direct_send"), "Check the recipient and message, then try again.");
  assert.equal(directSendErrorText("rate_limited"), "Too many sends — wait a minute and try again.");
});

test("directSendErrorText never implies a send on unknown codes", () => {
  for (const code of [undefined, null, "", "sent", "weird_code"]) {
    const line = directSendErrorText(code);
    assert.equal(line, "Send failed. Nothing was confirmed sent.", String(code));
    assert.ok(!/^sent/i.test(line), `must not read as sent: ${line}`);
  }
});

// --- validDirectSendResponse: the POST /channel-sends receipt contract ---

const receipt = (extra = {}) => ({
  contractVersion: 1,
  send: { id: "send-1", status: "sent", channel: "gmail" },
  ...extra,
});

test("validDirectSendResponse accepts well-formed sent/failed receipts", () => {
  assert.ok(validDirectSendResponse(receipt()));
  assert.ok(validDirectSendResponse(receipt({ send: { id: "s2", status: "failed", channel: "telegram", errorCode: "rate_limited" } })));
});

test("validDirectSendResponse rejects anything that is not a final receipt", () => {
  // A non-final status must never validate: the composer only reports
  // pending → sent | failed, and "Sent." on a queued receipt would lie.
  assert.ok(!validDirectSendResponse(receipt({ send: { id: "s", status: "queued", channel: "gmail" } })));
  assert.ok(!validDirectSendResponse(receipt({ send: { id: "s", status: "unknown", channel: "gmail" } })));
  assert.ok(!validDirectSendResponse(receipt({ contractVersion: 2 })));
  assert.ok(!validDirectSendResponse(receipt({ send: { id: 7, status: "sent", channel: "gmail" } })));
  assert.ok(!validDirectSendResponse(receipt({ send: { id: "s", status: "sent", channel: "sms" } })));
  assert.ok(!validDirectSendResponse(receipt({ send: null })));
  assert.ok(!validDirectSendResponse(null));
  assert.ok(!validDirectSendResponse({}));
});

// --- isSendableDraft: which sources expose a send path ---

test("isSendableDraft allows the synthetic simulator and capable Telegram", () => {
  assert.ok(isSendableDraft({ source: { adapter: "synthetic" } }));
  assert.ok(isSendableDraft({ source: { adapter: "telegram", capabilities: { send: true } } }));
});

test("isSendableDraft denies email and Telegram without send capability", () => {
  // Email has no browser send path; a send button there could never work.
  assert.ok(!isSendableDraft({ source: { adapter: "email" } }));
  assert.ok(!isSendableDraft({ source: { adapter: "telegram", capabilities: { send: false } } }));
  assert.ok(!isSendableDraft({ source: { adapter: "telegram", capabilities: {} } }));
  // A Telegram draft without capabilities is a programming error, not a
  // denial: the gate reads capabilities.send directly, as before.
  assert.throws(() => isSendableDraft({ source: { adapter: "telegram" } }), TypeError);
  assert.ok(!isSendableDraft(null));
  // A draft without a source is malformed input: the gate reads source.adapter
  // directly, as the original closure did.
  assert.throws(() => isSendableDraft({}), TypeError);
});

// --- validReplyReviewPending: untrusted sessionStorage shape ---

const pending = (extra = {}) => ({
  action: "reply.review",
  requestId: "req_1",
  sourceId: "src.1",
  attemptId: "att-1",
  expectedRevision: 3,
  reviewVersion: "a".repeat(64),
  ...extra,
});

test("validReplyReviewPending accepts well-formed pending reviews", () => {
  assert.ok(validReplyReviewPending(pending()));
  assert.ok(validReplyReviewPending(pending({
    action: "reply.update.review",
    updateId: "upd:1",
    reviewVersion: "0123456789abcdef".repeat(4),
  })));
});

test("validReplyReviewPending rejects malformed or foreign requests", () => {
  assert.ok(!validReplyReviewPending(pending({ action: "send.reserve" })));
  assert.ok(!validReplyReviewPending(pending({ action: "reply.review" , requestId: "../evil" })));
  assert.ok(!validReplyReviewPending(pending({ requestId: "x".repeat(200) })));
  assert.ok(!validReplyReviewPending(pending({ expectedRevision: -1 })));
  assert.ok(!validReplyReviewPending(pending({ expectedRevision: 1.5 })));
  assert.ok(!validReplyReviewPending(pending({ reviewVersion: "not-hex" })));
  assert.ok(!validReplyReviewPending(pending({ reviewVersion: "a".repeat(63) })));
  // reply.update.review requires the update id; reply.review must not need it.
  assert.ok(!validReplyReviewPending(pending({ action: "reply.update.review" })));
  assert.ok(!validReplyReviewPending(null));
  assert.ok(!validReplyReviewPending({}));
});
