// Shipped email envelopes keep attachment descriptors, not file bytes.
import test from "node:test";
import assert from "node:assert/strict";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { readEmailEnvelope, previewEmailReply, createEmailEnvelope } from "../server/email-envelope.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";

test("Graph contentBytes never appear on the normalized envelope", () => {
  const f = emailContractFixture();
  f.options.attachmentObservation.items[0].contentBytes = "c2VjcmV0";
  const envelope = normalizeGraphEmail(f.connection, f.message, f.options);
  const json = JSON.stringify(envelope);
  assert.equal(envelope.attachments.items[0].name, "brief.txt");
  assert.equal(Object.hasOwn(envelope.attachments.items[0], "contentBytes"), false);
  assert.equal(Object.hasOwn(envelope.attachments.items[0], "bytes"), false);
  assert.equal(/c2VjcmV0|contentBytes/.test(json), false);
  assert.deepEqual(readEmailEnvelope(envelope), envelope);
});

test("createEmailEnvelope refuses extra byte fields on attachment items", () => {
  const f = emailContractFixture();
  const envelope = normalizeGraphEmail(f.connection, f.message, f.options);
  const poisoned = structuredClone(envelope);
  poisoned.attachments.items[0].bytes = [1, 2, 3];
  assert.throws(() => readEmailEnvelope(poisoned));
  const input = {
    connection: envelope.connection,
    message: envelope.message,
    body: envelope.body,
    replyHeaders: envelope.replyHeaders,
    attachments: {
      state: "complete",
      hint: true,
      items: [{ ...envelope.attachments.items[0], contentBytes: "AAAA" }]
    }
  };
  assert.throws(() => createEmailEnvelope(input));
});

test("previewEmailReply never forwards source attachments", () => {
  const f = emailContractFixture();
  const source = normalizeGraphEmail(f.connection, f.message, f.options);
  assert.equal(source.attachments.items.length, 1);
  const reply = previewEmailReply(source, f.connection, { body: "Happy to help." });
  assert.deepEqual(reply.attachments, []);
  assert.equal(/brief\.txt/.test(JSON.stringify(reply)), false);
});
