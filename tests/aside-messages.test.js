// "aside:" human messages wake no agent and do not count as needs-me.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { isAsideBody, isHumanAside } from "../src/aside.js";

test("isAsideBody matches a leading aside: in any case", () => {
  assert.equal(isAsideBody("aside: lunch?"), true);
  assert.equal(isAsideBody("  ASIDE: x"), true);
  assert.equal(isAsideBody("not an aside: x"), false);
  assert.equal(isAsideBody(null), false);
  const members = { h: { kind: "human" }, a: { kind: "agent" } };
  assert.equal(isHumanAside(members, "h", "aside: hi"), true);
  assert.equal(isHumanAside(members, "a", "aside: hi"), false, "agents cannot go quiet with aside");
});

test("a human aside @mention creates no mention row and no wake; a normal one does", () => {
  const f = createAcceptanceFixture();
  try {
    const identity = f.store.identities.create("aside-agent");
    f.store.identities.link(f.keys.owner, "commons", { identityId: identity.identityId, memberId: "asideagent", displayName: "Asideagent", permissions: ["accept_work"] });
    f.store.agentHeartbeats.heartbeat({ agentId: identity.identityId, hostId: "h1", mode: "pull-only" });
    const post = body => f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body } });
    const rows = () => f.store.db.prepare("SELECT COUNT(*) AS n FROM mention_states WHERE room_id='commons' AND mentioned_member_id='asideagent'").get().n;
    const wakes = () => f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals WHERE agent_id=?").get(identity.identityId).n;
    post("aside: @Asideagent no need to act on this");
    assert.equal(rows(), 0);
    assert.equal(wakes(), 0);
    post("@Asideagent please look");
    assert.equal(rows(), 1);
  } finally { f.store.close(); }
});
