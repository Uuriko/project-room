import test from "node:test";
import assert from "node:assert/strict";
import { inviteMintBody, COLLABORATE_PERMISSIONS, agentInviteHandoff, agentInviteJoinLink, mintInviteLink, inviteLinksText, BULK_MINT_COUNTS, inviteMintFailureMessage } from "../src/agent-invite-ui.js";

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
  assert.equal(handoff.link, "https://www.getdasha.com/room/join/RM-EXAMPLE");
  assert.equal(handoff.code, "RM-EXAMPLE");
  assert.match(handoff.text, /agent-inbox.mjs join/);
  assert.match(handoff.text, /--accept/);
  assert.match(handoff.text, /running host/);
  assert.equal(agentInviteHandoff("RM-EXAMPLE", { origin: "http://127.0.0.1:3000", pathname: "/" }).link,
    "http://127.0.0.1:3000/join/RM-EXAMPLE");
  assert.throws(() => agentInviteHandoff("RM-bad; command"));
});

test("agent invite join link preserves the www door /room path", () => {
  assert.equal(agentInviteJoinLink("RM-ABC", { origin: "https://www.getdasha.com", pathname: "/room" }),
    "https://www.getdasha.com/room/join/RM-ABC");
  assert.equal(agentInviteJoinLink("RM-ABC", { origin: "https://room.example", pathname: "/" }),
    "https://room.example/join/RM-ABC");
  assert.equal(agentInviteJoinLink("RM-ABC", { origin: "https://room.example", pathname: "/room/" }),
    "https://room.example/room/join/RM-ABC");
  assert.throws(() => agentInviteJoinLink("bad"), /Invalid agent invite/);
  assert.throws(() => agentInviteJoinLink("RM-ABC", { origin: "https://room.example", pathname: "/evil" }), /Invalid Room address/);
});

test("bulk mint counts are the fixed 1/5/10/25 selector", () => {
  assert.deepEqual([...BULK_MINT_COUNTS], [1, 5, 10, 25]);
});

test("mint invite link builds one self-serve join link", async () => {
  const link = await mintInviteLink({
    requestBody: () => ({ profile: "contribute" }),
    mintOne: async () => ({ code: "RM-CODE1", roomId: "room-1" }),
    locationLike: { origin: "https://room.example", pathname: "/" },
  });
  assert.deepEqual(link, { code: "RM-CODE1", link: "https://room.example/join/RM-CODE1" });
  assert.equal(inviteLinksText([link]), "https://room.example/join/RM-CODE1");
  await assert.rejects(() => mintInviteLink({
    requestBody: () => ({}),
    mintOne: async () => ({ code: "nope", roomId: "room-1" }),
    locationLike: { origin: "https://room.example", pathname: "/" },
  }), /could not be confirmed/);
});

test("bulk mints call one request per invite with distinct display names", async () => {
  const bodies = [];
  const locationLike = { origin: "https://room.example", pathname: "/" };
  for (let index = 0; index < 5; index++) {
    bodies.push(inviteMintBody("contribute", index === 0 ? "Peer agent" : ""));
  }
  const links = [];
  for (const body of bodies) {
    links.push(await mintInviteLink({
      requestBody: () => body,
      mintOne: async data => ({ code: `RM-C${bodies.indexOf(data) + 1}`, roomId: "room-1" }),
      locationLike,
    }));
  }
  assert.equal(links.length, 5);
  assert.ok(links.every(entry => entry.link.startsWith("https://room.example/join/RM-C")));
  assert.equal(new Set(links.map(entry => entry.code)).size, 5);
});

test("mint failures name the problem in human words, not server vocabulary", () => {
  // 403 access_denied ("Invite grant required"): say who can fix it.
  const denied = inviteMintFailureMessage(Object.assign(new Error("Invite grant required"), { status: 403, code: "access_denied" }));
  assert.match(denied, /permission|owner/i);
  assert.doesNotMatch(denied, /Invite grant required/);
  // 403 invite_scope_exceeded: the dialog only offers standing profiles, so
  // this hits non-owner minters on Collaborate — point at Contribute.
  const scope = inviteMintFailureMessage(Object.assign(
    new Error("invite_member can only grant standing agent-safe permissions"), { status: 403, code: "invite_scope_exceeded" }));
  assert.match(scope, /Contribute|owner/i);
  assert.doesNotMatch(scope, /agent-safe permissions/);
  // 429 / rate_limited: say slow down, not "Request failed".
  const limited = inviteMintFailureMessage(Object.assign(new Error("Request failed"), { status: 429, code: "rate_limited" }));
  assert.match(limited, /wait|slow down|try again/i);
  // 409 pilot_limit: the room is full — not a permissions problem.
  const full = inviteMintFailureMessage(Object.assign(new Error("Bounded pilot capacity reached; no data was changed"), { status: 409, code: "pilot_limit" }));
  assert.match(full, /full|member limit/i);
  // Unknown errors keep the short server message; overlong ones fall back.
  assert.equal(inviteMintFailureMessage(new Error("short server note")), "short server note");
  assert.match(inviteMintFailureMessage(new Error("x".repeat(200))), /Could not create an invite/);
  assert.match(inviteMintFailureMessage(null), /Could not create an invite/);
});
