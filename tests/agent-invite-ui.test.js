import test from "node:test";
import assert from "node:assert/strict";
import { inviteMintBody, COLLABORATE_PERMISSIONS, agentInviteHandoff } from "../src/agent-invite-ui.js";

test("invite mint body: contribute/review use standing profiles", () => {
  assert.deepEqual(inviteMintBody("contribute"), { profile: "contribute" });
  assert.deepEqual(inviteMintBody("review", "  Muse  "), { profile: "review", displayName: "Muse" });
  assert.deepEqual(inviteMintBody("chat"), { profile: "chat" });
});

test("invite mint body: collaborate is owner-shaped permissions, agent-safe plus steer", () => {
  assert.deepEqual(inviteMintBody("collaborate"), { permissions: [...COLLABORATE_PERMISSIONS] });
  assert.deepEqual(COLLABORATE_PERMISSIONS, ["steer", "accept_work", "complete_work", "verify"]);
  assert.ok(!COLLABORATE_PERMISSIONS.includes("manage_members"));
  assert.ok(!COLLABORATE_PERMISSIONS.includes("decide"));
  assert.ok(!COLLABORATE_PERMISSIONS.includes("invite_member"));
});

test("invite mint body rejects unknown profiles and overlong names", () => {
  assert.throws(() => inviteMintBody("admin"), /contribute, collaborate, or review/);
  assert.throws(() => inviteMintBody("contribute", "x".repeat(81)), /80 characters/);
});


test("agent handoff retains the current service and carries a resumable command", () => {
  const handoff = agentInviteHandoff("RM-EXAMPLE", { origin: "https://www.getdasha.com", pathname: "/room/" });
  assert.equal(handoff.link, "https://www.getdasha.com/room#agent-invite/RM-EXAMPLE");
  assert.match(handoff.text, /agent-inbox.mjs join/);
  assert.match(handoff.text, /--accept/);
  assert.match(handoff.text, /running host/);
  assert.equal(agentInviteHandoff("RM-EXAMPLE", { origin: "http://127.0.0.1:3000", pathname: "/" }).link,
    "http://127.0.0.1:3000#agent-invite/RM-EXAMPLE");
  assert.throws(() => agentInviteHandoff("RM-bad; command"));
});
