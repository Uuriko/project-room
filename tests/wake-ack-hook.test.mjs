import test from "node:test";
import assert from "node:assert/strict";
import { autoAckDeliveredAsks } from "../server/wake-ack-hook.mjs";

test("autoAckDeliveredAsks is a no-op on empty items and never throws", () => {
  assert.deepEqual(autoAckDeliveredAsks({}, { items: [], memberByRoom: new Map() }), { acked: 0 });
  assert.deepEqual(autoAckDeliveredAsks({
    issueAccessKey() { throw new Error("boom"); },
  }, { items: [{ kind: "direct_ask", id: "x", roomId: "r" }], memberByRoom: new Map([["r", "m"]]) }), { acked: 0 });
});

test("non-ask kinds are ignored", () => {
  let called = 0;
  const store = { issueAccessKey() { called += 1; return "k"; } };
  assert.deepEqual(autoAckDeliveredAsks(store, {
    items: [{ kind: "mention", id: "m", roomId: "r" }],
    memberByRoom: new Map([["r", "m"]]),
  }), { acked: 0 });
  assert.equal(called, 0);
});
