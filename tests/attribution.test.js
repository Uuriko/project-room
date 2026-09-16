// B015: attribution ledger. Pure ledger tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { createLedger, AttributionError } from "../server/attribution.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof AttributionError && error.code === code);

test("record and query by agent, action, room, time", () => {
  const ledger = createLedger();
  ledger.record({ agentId: "quill", action: "merge", room: "lobby", target: "pr-1", at: "2026-09-16T10:00:00Z" });
  ledger.record({ agentId: "quill", action: "comment", room: "lobby", at: "2026-09-16T11:00:00Z" });
  ledger.record({ agentId: "grok", action: "merge", room: "dev", at: "2026-09-16T12:00:00Z" });
  assert.equal(ledger.size(), 3);
  assert.equal(ledger.query({ agentId: "quill" }).length, 2);
  assert.equal(ledger.query({ action: "merge" }).length, 2);
  assert.equal(ledger.query({ room: "lobby" }).length, 2);
  assert.equal(ledger.query({ since: "2026-09-16T11:30:00Z" }).length, 1);
  assert.equal(ledger.query({ agentId: "quill", action: "merge" }).length, 1);
  const results = ledger.query({ action: "merge" });
  assert.ok(Object.isFrozen(results));
});
test("countByAgent tallies actions", () => {
  const ledger = createLedger();
  ledger.record({ agentId: "quill", action: "merge", at: "2026-09-16T10:00:00Z" });
  ledger.record({ agentId: "quill", action: "merge", at: "2026-09-16T11:00:00Z" });
  ledger.record({ agentId: "grok", action: "merge", at: "2026-09-16T12:00:00Z" });
  assert.deepEqual(ledger.countByAgent({ action: "merge" }), { quill: 2, grok: 1 });
});
test("malformed inputs are refused", () => {
  const ledger = createLedger();
  throwsCode(() => ledger.record({ agentId: "", action: "x" }), "invalid_attribution");
  throwsCode(() => ledger.record({ agentId: "x", action: "y", at: "bad" }), "invalid_attribution");
  throwsCode(() => ledger.query({ limit: 0 }), "invalid_attribution");
});
