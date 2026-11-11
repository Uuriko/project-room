import test from "node:test";
import assert from "node:assert/strict";
import { claimSnippet } from "../server/needs-me.mjs";

test("claimSnippet skips the machine retention receipt (QA 2026-10-20)", () => {
  const history = [
    { action: "created", note: null },
    { action: "claimed", note: "lease: 2h" },
    { action: "retention_ack", note: "retention-ack seen=1 first=1 sla_due=2026-10-22T06:36:48.617Z" }
  ];
  assert.equal(claimSnippet({ history }), "lease: 2h");
  assert.equal(claimSnippet({ history: [history[2]] }), null);
  assert.equal(claimSnippet({ acceptanceCriteria: ["Ship it"], history }), "Ship it");
});
