import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { confirmsWorkReturn } from "../src/workflow.js";
import { retryUnconfirmed } from "../src/client.js";

test("draft return confirms only an exact owned stable-message receipt", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const command = { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: crypto.randomUUID(), workItemId: "test-handoff", packetId: "same-packet", basisRevision: 0, body: "Synthetic draft"
  } };
  const receipt = f.store.command(f.keys.guest, "commons", command);
  const match = candidate => confirmsWorkReturn(candidate, command, "commons", "guest");
  assert.equal(match(receipt), true);
  assert.equal(match(f.store.command(f.keys.guest, "commons", command)), true);
  for (const value of [null, {}, { sequence: 1 }, { ...receipt, sequence: 0 }, { ...receipt, sequence: 1.5 }, { ...receipt, sequence: "1" }, { ...receipt, duplicate: 1 }, { ...receipt, event: null }]) assert.equal(match(value), false);
  for (const [key, value] of [["roomId", "other"], ["actorId", "producer"], ["type", T.WORK_COMPLETED], ["id", "bad/id"]]) {
    assert.equal(match({ ...receipt, event: { ...receipt.event, [key]: value } }), false, key);
  }
  for (const [key, value] of [["messageId", "another-message"], ["workItemId", "other"], ["packetId", "other"], ["basisRevision", 1], ["body", "other"], ["extra", true]]) {
    assert.equal(match({ ...receipt, event: { ...receipt.event, data: { ...receipt.event.data, [key]: value } } }), false, key);
  }
  assert.equal(match({ ...receipt, event: { ...receipt.event, data: [] } }), false);
  assert.equal(confirmsWorkReturn(receipt, { ...command, data: { ...command.data, messageId: null } }, "commons", "guest"), false);
  assert.equal(confirmsWorkReturn(receipt, { ...command, type: T.WORK_PROPOSED }, "commons", "guest"), false);
  // Same packet/content is a legitimate separate contribution, not this receipt.
  const other = { ...command, id: crypto.randomUUID(), data: { ...command.data, messageId: crypto.randomUUID() } };
  assert.equal(match(f.store.command(f.keys.guest, "commons", other)), false);
});

test("unknown draft commits stay locked across pre-ledger errors and conflicts", () => {
  for (const error of [new Error("lost"), { status: 500 }, { status: 429, code: "rate_limited" }, { status: 413, code: "too_large" },
    { status: 422, code: "invalid_command" }, { status: 409, code: "idempotency_conflict" }, { status: 403, code: "access_denied" },
    { status: 401, code: "unauthenticated" }, { status: 409, code: "unrecognized" }, { status: 500, code: "command_rejected" }]) {
    assert.equal(retryUnconfirmed(error, true), true, JSON.stringify(error));
  }
  for (const error of [{ status: 409, code: "command_rejected" }, { status: 422, code: "command_rejected" }, { status: 422, code: "invalid_cause" }, { status: 409, code: "pilot_limit" }]) {
    assert.equal(retryUnconfirmed(error, true), false);
    assert.equal(retryUnconfirmed(error, false), false);
  }
  assert.equal(retryUnconfirmed({ status: 413, code: "too_large" }, false), false);
  assert.equal(retryUnconfirmed({ status: 422, code: "invalid_command" }, false), false);
});
