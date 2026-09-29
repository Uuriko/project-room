import { test } from "node:test";
import assert from "node:assert/strict";
import { trustTools, isTrustTool, validTrustToolArguments } from "../client/trust-tools.mjs";

test("exposes exactly the two read tools", () => {
  assert.deepEqual(trustTools.map(t => t.name).sort(), ["identity_list_verified", "identity_read_verification"]);
});

test("never exposes an attestation write", () => {
  for (const tool of trustTools) {
    assert.ok(!/verify_identity|record_verification|attest/i.test(tool.name),
      `${tool.name} looks like a write; attestation stays a room-owner seat`);
  }
  assert.equal(isTrustTool("identity_verify"), false);
  assert.equal(isTrustTool("room_record_verification"), false);
});

test("every tool declares a schema with no required caller-asserted tier", () => {
  for (const tool of trustTools) {
    assert.ok(tool.inputSchema, `${tool.name} has no schema`);
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(!("level" in (tool.inputSchema.properties ?? {})),
      `${tool.name} lets a caller pass a tier`);
  }
});

test("read accepts self, accepts a named identity, rejects junk", () => {
  assert.equal(validTrustToolArguments("identity_read_verification", {}), true);
  assert.equal(validTrustToolArguments("identity_read_verification", { identityId: "ai_abc" }), true);
  assert.equal(validTrustToolArguments("identity_read_verification", { identityId: 7 }), false);
  assert.equal(validTrustToolArguments("identity_read_verification", { level: "verified" }), false);
});

test("list takes no arguments", () => {
  assert.equal(validTrustToolArguments("identity_list_verified", {}), true);
  assert.equal(validTrustToolArguments("identity_list_verified", { identityId: "ai_abc" }), false);
});

test("unknown tool names are rejected", () => {
  assert.equal(isTrustTool("nonsense"), false);
  assert.equal(validTrustToolArguments("nonsense", {}), false);
});
