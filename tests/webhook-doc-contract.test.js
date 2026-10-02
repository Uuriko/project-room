// The public webhook pages name the timestamp format and signature headers
// that server/webhook-dispatch.mjs puts on the delivery POST. A doc edit
// that restores "unix ms in the timestamp header", or a sender edit that
// stops emitting ISO-8601 / x-webhook-signature, fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  signDelivery, verifyDeliverySignature, deliveryEnvelope, deliveryHeaders, postDelivery,
} from "../server/webhook-dispatch.mjs";
import { signPayload, verifySignature } from "../server/agent-webhook-subscriptions.mjs";

const SECRET = "doc-secret-0123456789abcdef";
const ISSUED_AT = 1_700_000_000_000;
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };

test("documented webhook timestamp and signature headers match the delivery POST", async () => {
  const fields = {
    deliveryId: "del_doc", subscriptionId: "sub_doc", eventType: "message.posted",
    issuedAt: ISSUED_AT, data: { n: 1 },
  };
  const signature = signDelivery(SECRET, fields);
  const headers = deliveryHeaders({ ...fields, signature });
  const envelope = deliveryEnvelope({ ...fields, roomId: "room-1" });
  const iso = new Date(ISSUED_AT).toISOString();

  assert.equal(headers["x-webhook-timestamp"], iso);
  assert.match(headers["x-webhook-timestamp"], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(envelope.issuedAt, iso);
  assert.equal(headers["x-webhook-signature"], `sha256=${signature}`);
  assert.equal(verifyDeliverySignature(SECRET, headers["x-webhook-signature"], fields), true);
  assert.equal(verifyDeliverySignature(SECRET, headers["x-webhook-signature"], { ...fields, issuedAt: envelope.issuedAt }), false);

  let posted;
  const result = await postDelivery({
    fetchImpl: async (_url, init) => { posted = init; return { status: 200, text: async () => "ok" }; },
    url: "https://hooks.example.test/agent",
    envelope, headers, dnsResolvers: publicDns,
  });
  assert.equal(result.ok, true);
  assert.equal(posted.headers["x-webhook-timestamp"], iso);
  assert.equal(posted.headers["x-webhook-signature"], `sha256=${signature}`);
  assert.equal(JSON.parse(posted.body).issuedAt, iso);

  const bare = signPayload(SECRET, { eventType: fields.eventType, data: fields.data });
  assert.match(bare, /^[0-9a-f]{64}$/);
  assert.equal(bare.includes("sha256="), false);
  assert.equal(verifySignature(SECRET, bare, { eventType: fields.eventType, data: fields.data }), true);
  assert.notEqual(bare, signature);

  const wakeups = readFileSync(new URL("../docs/WEBHOOK-WAKEUPS.md", import.meta.url), "utf8");
  const swarm = readFileSync(new URL("../docs/SWARM-PLUG-IN.md", import.meta.url), "utf8");
  for (const doc of [wakeups, swarm]) {
    assert.match(doc, /x-webhook-timestamp/);
    assert.match(doc, /x-webhook-signature/);
    assert.match(doc, /ISO-8601/);
    assert.match(doc, /sha256=/);
    assert.match(doc, /unix milliseconds/);
  }
  assert.match(wakeups, /verify-delivery/);
  assert.match(wakeups, /\{ eventType, data \}/);
  assert.match(wakeups, /bare hex/);
  assert.match(wakeups, /`X-ProjectRoom-Signature` is not a header this server sends/);
  assert.equal(/^\| `X-ProjectRoom-Signature`/m.test(wakeups), false);
  assert.equal(Object.hasOwn(posted.headers, "x-projectroom-signature"), false);
});
