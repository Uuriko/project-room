// UT2 02-08 F2 + 04-04 F1 (PR-1): bounty_accept's documented attestation
// shape must be the shape the escrow accepts, and the anonymous tools/list
// must not silently swallow a bogus profile/focus.
//
// Production evidence (wave-2026-10-27-user-testing-2, lanes 02-08 / 04-04):
// - bounty_accept's description presented the attestation as a bare list
//   [{criterionId, verdict}] -> -32602 "wrong type"; an object with a
//   "criteria" key -> 422 missing_citations. The only working shape,
//   {citations: [{criterionId, verdict}]}, appeared in neither the schema
//   (type object, minProperties 1, no properties) nor the description.
// - Anonymous tools/list ignored profile/focus across 18 variants: a bogus
//   profile was indistinguishable from a correct one (the authenticated
//   handler rejects the same values with -32602).
import test from "node:test";
import assert from "node:assert/strict";

import { bountyTools, validBountyToolArguments } from "../client/bounty-tools.mjs";
import { hostedStdioToolDefinitions, validHostedStdioArgs } from "../server/mcp-full-profile.mjs";
import { handleMcpJoinRpc } from "../server/mcp-http.mjs";

const entry = bountyTools.find(tool => tool.name === "bounty_accept");
const hosted = hostedStdioToolDefinitions().find(tool => tool.name === "bounty_accept");

test("bounty_accept schema declares the citations shape the escrow requires", () => {
  assert.ok(entry, "bounty_accept must exist");
  const attestation = entry.inputSchema.properties.verifierAttestation;
  assert.equal(attestation.type, "object");
  assert.ok(attestation.properties, "verifierAttestation must declare its properties");
  const citations = attestation.properties.citations;
  assert.ok(citations, "verifierAttestation.citations must be declared");
  assert.equal(citations.type, "array");
  assert.ok(citations.minItems >= 1, "citations must require at least one citation");
  assert.equal(citations.items.type, "object");
  assert.deepEqual([...citations.items.required].sort(), ["criterionId", "verdict"],
    "each citation requires criterionId and verdict");
  assert.deepEqual(citations.items.properties.verdict.enum, ["pass", "fail"],
    "verdict is pass|fail, matching CITATION_VERDICTS in the escrow");
  assert.ok(attestation.required?.includes("citations"), "citations is required inside the attestation");
  // The hosted (roomId-wrapped) definition carries the same nested shape.
  assert.deepEqual(hosted.inputSchema.properties.verifierAttestation, attestation);
});

test("bounty_accept description states the object shape, not the bare list", () => {
  assert.match(entry.description, /\{citations:\s*\[\{criterionId, verdict/,
    "description must show {citations: [{criterionId, verdict, ...}]}");
  assert.doesNotMatch(entry.description, /attestation with citations: \[\{/,
    "the old list-shaped reading must be gone");
});

test("the working attestation shape validates; the documented-broken shapes do not reach the escrow as valid", () => {
  const working = { citations: [{ criterionId: "c1", verdict: "pass" }] };
  assert.ok(validBountyToolArguments("bounty_accept", { bountyId: "ROOM-1", verifierAttestation: working }));
  assert.ok(validHostedStdioArgs("bounty_accept", { roomId: "commons", bountyId: "ROOM-1", verifierAttestation: working }));
  // The bare list the old description taught is not an object: refused.
  assert.equal(validBountyToolArguments("bounty_accept",
    { bountyId: "ROOM-1", verifierAttestation: [{ criterionId: "c1", verdict: "pass" }] }), false);
  // An empty object carries no citations: refused.
  assert.equal(validBountyToolArguments("bounty_accept", { bountyId: "ROOM-1", verifierAttestation: {} }), false);
});

test("anonymous tools/list rejects a bogus profile or focus instead of silently ignoring it", () => {
  const bogusProfile = handleMcpJoinRpc(
    { jsonrpc: "2.0", id: "t1", method: "tools/list", params: { profile: "bogusprofile123" } }, {});
  assert.equal(bogusProfile.error?.code, -32602, JSON.stringify(bogusProfile));
  assert.match(bogusProfile.error?.data?.invalid?.profile ?? bogusProfile.error?.message ?? "",
    /core, lean or full/);

  const bogusFocus = handleMcpJoinRpc(
    { jsonrpc: "2.0", id: "t2", method: "tools/list", params: { focus: "bogusfocus" } }, {});
  assert.equal(bogusFocus.error?.code, -32602, JSON.stringify(bogusFocus));
});

test("anonymous tools/list with a valid profile still serves the public catalog", () => {
  for (const params of [{}, { profile: "full" }, { profile: "lean" }, { focus: "work" }]) {
    const reply = handleMcpJoinRpc({ jsonrpc: "2.0", id: "t3", method: "tools/list", params }, {});
    assert.ok(Array.isArray(reply.result?.tools), JSON.stringify(reply));
    assert.equal(reply.result.tools.length, 7, "the anonymous catalog is the fixed public set");
  }
});
