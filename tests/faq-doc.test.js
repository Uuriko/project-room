// O010: FAQ document exists and has expected sections.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
test("FAQ.md exists with core sections", () => {
  const path = join(root, "docs", "FAQ.md");
  assert.ok(existsSync(path), "docs/FAQ.md should exist");
  const content = readFileSync(path, "utf8");
  for (const section of ["## General", "## Rooms", "## Agents", "## Work Items",
      "## Privacy & Security", "## Troubleshooting"]) {
    assert.ok(content.includes(section), `FAQ should include ${section}`);
  }
});

// O011 groundability: enrollment-troubleshooting entries must exist in the
// FAQ, and every user-facing error code / route they cite must still exist in
// code. If a code or route is renamed, this fails and the doc must follow.
test("FAQ enrollment troubleshooting entries ground to code", () => {
  const faq = readFileSync(join(root, "docs", "FAQ.md"), "utf8");
  const entries = [
    "invite code was rejected",
    "I lost my agent identity secret",
    "origin_denied",
  ];
  for (const entry of entries) {
    assert.ok(faq.toLowerCase().includes(entry.toLowerCase()),
      `FAQ should cover: ${entry}`);
  }
  const agentInvites = readFileSync(join(root, "server", "agent-invites.mjs"), "utf8");
  for (const code of ["invite_unavailable", "invite_expired", "invite_revoked",
      "invite_already_used", "invite_authority_changed"]) {
    assert.ok(faq.includes(code), `FAQ should name the ${code} code`);
    assert.ok(agentInvites.includes(`"${code}"`),
      `server/agent-invites.mjs should still emit the ${code} code`);
  }
  const identities = readFileSync(join(root, "server", "agent-identities.mjs"), "utf8");
  assert.ok(identities.includes('"identity_revoked"'),
    "server/agent-identities.mjs should still emit identity_revoked");
  const discoverability = readFileSync(join(root, "server", "discoverability.mjs"), "utf8");
  for (const route of ["/api/agent-identities/{identityId}/rotate",
      "/api/agent-identities/{identityId}/revoke"]) {
    assert.ok(discoverability.includes(route),
      `server/discoverability.mjs should still declare the ${route} route`);
  }
});

// O011 groundability: the identity lifecycle doc exists, names the real
// states and the terminal state, and records the no-pause gap honestly.
test("identity lifecycle doc grounds to code", () => {
  const path = join(root, "docs", "IDENTITY-LIFECYCLE.md");
  assert.ok(existsSync(path), "docs/IDENTITY-LIFECYCLE.md should exist");
  const content = readFileSync(path, "utf8");
  const identities = readFileSync(join(root, "server", "agent-identities.mjs"), "utf8");
  assert.ok(identities.includes("revoke is the final state"),
    "server/agent-identities.mjs should still document revoke as final");
  for (const term of ["rotate", "revoke", "unlink", "terminal"]) {
    assert.ok(content.includes(term),
      `IDENTITY-LIFECYCLE.md should document: ${term}`);
  }
});
