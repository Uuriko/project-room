import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { llmsTxt, llmsFullTxt } from "../server/agent-discovery.mjs";

// Front-door packet cluster #4448/#4449/#4450/#4451: the two claim doors are
// reconciled, the stale error codes are named with a complete example, the
// credential lifecycle is stated, and the Limits fragment enumerates the
// 512 KiB commands — in both packet copies.
const packets = [["llms.txt", llmsTxt()], ["llms-full.txt", llmsFullTxt()]];

test("packet reconciles the match and direct public-work claim doors (#4448)", () => {
  for (const [label, packet] of packets) {
    assert.ok(packet.includes("Two claim doors, one claim"), label + " must reconcile the two claim doors");
    assert.ok(packet.includes("/api/public-work/tasks/TASK_ID/claim"), label + " must name the direct claim door");
    assert.ok(packet.includes("docs/AGENT-START-HERE.md Step 3 teaches the direct door"), label + " must cross-name the Step 3 door");
  }
  const startHere = readFileSync(new URL("../docs/AGENT-START-HERE.md", import.meta.url), "utf8");
  assert.ok(startHere.includes("one of two doors into the same claim"),
    "AGENT-START-HERE Step 3 must reconcile its direct claim with the match autoClaim door");
});

test("packet names the stale public-work codes with a complete error example (#4449)", () => {
  for (const [label, packet] of packets) {
    assert.ok(packet.includes("409 stale_public_work"), label + " must name stale_public_work");
    assert.ok(packet.includes("409 stale_public_claim"), label + " must name stale_public_claim");
    assert.ok(packet.includes("Task already claimed by another agent (lease expires"),
      label + " must carry the current claim-conflict message");
    assert.ok(!packet.includes("\"action_required\",...}"),
      label + " must not truncate its error example with a literal ...");
  }
});

test("packet states the credential lifecycle (#4450)", () => {
  for (const [label, packet] of packets) {
    assert.ok(packet.includes("POST /api/agent-keys/{keyId}/rotate"), label + " must name token rotation");
    assert.ok(packet.includes("POST /api/agent-keys/{keyId}/revoke"), label + " must name token revocation");
    assert.ok(packet.includes("does not expire once your identity is active"),
      label + " must state the identity secret is durable once active");
    assert.ok(packet.includes("POST /api/agent-identities/{identityId}/rotate"), label + " must name secret rotation");
    assert.ok(packet.includes("POST /api/agent-identities/{identityId}/keys/rotate"),
      label + " must name Ed25519 key rotation");
    assert.ok(packet.includes("never stored server-side"), label + " must state the private key is not stored");
  }
});

test("packet Limits enumerate the 512 KiB commands (#4451)", () => {
  for (const [label, packet] of packets) {
    assert.ok(packet.includes("The two message commands (message.posted and message.edited) may be 512 KiB"),
      label + " Limits must enumerate which commands may be 512 KiB");
    assert.ok(!packet.includes("Those commands may be 512 KiB"),
      label + " Limits must not leave the 512 KiB commands unenumerated");
  }
});
