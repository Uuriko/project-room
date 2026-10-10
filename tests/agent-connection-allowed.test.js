// 8377: every "Add an agent" affordance keys off one predicate, so the
// Connect Room dialog's enroll button cannot offer a click the hidden
// People-panel button would swallow.
import test from "node:test";
import assert from "node:assert/strict";
import { agentConnectionAllowed } from "../src/agent-connections.js";

const owner = { id: "owner", kind: "human", active: true, permissions: ["manage_members"] };
const state = { room: { id: "room", ownerId: "owner" }, members: { owner } };
const client = { ownsAccountSession: () => true, session: { account: { id: "acc" }, roomId: "room", member: { id: "owner" } } };

test("agent connection right is the room owner on an account session", () => {
  assert.equal(agentConnectionAllowed({ client, getState: () => state }), true);
  assert.equal(agentConnectionAllowed({ client: { ...client, ownsAccountSession: () => false }, getState: () => state }), false, "accountless session");
  assert.equal(agentConnectionAllowed({ client: { ...client, session: { ...client.session, account: null } }, getState: () => state }), false, "no account on the session");
  assert.equal(agentConnectionAllowed({ client, getState: () => ({ ...state, room: { ...state.room, ownerId: "other" } }) }), false, "non-owner manager");
  assert.equal(agentConnectionAllowed({ client, getState: () => ({ ...state, members: { owner: { ...owner, kind: "agent" } } }) }), false, "agent member");
  assert.equal(agentConnectionAllowed({ client, getState: () => ({ ...state, members: { owner: { ...owner, active: false } } }) }), false, "deactivated owner");
  assert.equal(agentConnectionAllowed({ client, getState: () => ({ ...state, members: { owner: { ...owner, permissions: [] } } }) }), false, "no manage_members");
  assert.equal(agentConnectionAllowed({ client: { ...client, session: { ...client.session, roomId: "elsewhere" } }, getState: () => state }), false, "session bound to another room");
  assert.equal(agentConnectionAllowed({ client, getState: () => null }), false, "no projection yet");
});
