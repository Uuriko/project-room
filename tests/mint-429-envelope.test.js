// MINT-BUDGET Pack 1 (D3/D4): a mint-budget 429 must name its scope and a
// non-wait alternative in the agent error envelope. The envelope layer
// (src/agent-error.mjs agentErrorAx) receives no error detail, so the mint
// sub-branch keys on the mint refusal messages themselves (the pack's
// flagged fallback) and derives the scope from the message. Every other
// 429 keeps the generic wait hint, byte for byte.
import test from "node:test";
import assert from "node:assert/strict";
import { agentErrorAx, mintBudgetAx } from "../src/agent-error.mjs";

const MINT_CASES = [
  ["Too many identity mints from this address in the last minute", "address", "8/minute"],
  ["Identity mint address budget reached for today", "address", "20/day"],
  ["Identity mint network budget reached for today", "network", "80/day"],
  ["Identity mint daily budget reached for today", "global", "200/day"],
];

test("mint-budget 429s name their scope, limit, and alternatives", () => {
  for (const [message, scope, limit] of MINT_CASES) {
    const ax = agentErrorAx({ httpStatus: 429, code: "rate_limited", message });
    assert.equal(ax.reason, "rate_limited", `${scope}: reason`);
    assert.ok(ax.hint.includes(scope), `${scope}: hint names the scope word`);
    assert.ok(ax.hint.includes(limit), `${scope}: hint names the limit`);
    assert.ok(ax.hint.length <= 160, `${scope}: hint stays under the 160-char contract (${ax.hint.length})`);
    assert.equal(ax.next.length, 3, `${scope}: three next commands`);
    const nextText = ax.next.map((n) => n.command ?? n.text ?? JSON.stringify(n)).join(" ");
    assert.ok(/re-solving any proof/i.test(nextText), `${scope}: wait command carries the proof re-solve warning`);
    assert.ok(/saved identity/i.test(nextText), `${scope}: reuse alternative present`);
  }
});

test("network and address mint 429s offer invite redemption; global names the shared spend", () => {
  const network = agentErrorAx({ httpStatus: 429, code: "rate_limited", message: "Identity mint network budget reached for today" });
  const networkNext = network.next.map((n) => n.command ?? n.text ?? JSON.stringify(n)).join(" ");
  assert.ok(networkNext.includes("POST /api/agent-invites/redeem"), "network: invite redeem command");
  const global = agentErrorAx({ httpStatus: 429, code: "rate_limited", message: "Identity mint daily budget reached for today" });
  assert.ok(/invites spend this budget too/.test(global.hint), "global: hint says invites spend the global budget");
});

test("non-mint 429s keep the generic hint unchanged", () => {
  const ax = agentErrorAx({ httpStatus: 429, code: "rate_limited", message: "slow down" });
  assert.equal(ax.hint, "Wait for the Retry-After interval, then retry the same request unchanged.");
  assert.equal(ax.next.length, 1);
  assert.equal(mintBudgetAx("slow down"), null);
  assert.equal(mintBudgetAx(""), null);
});
