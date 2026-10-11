// R36-1 UI read guard (WAVE-500 guild 3): the approvals list is the human's
// read surface before a verdict. The server resubmit() bug (John's Tab owns
// it) returns v2 but never stores it, so the queue copy the list serves is
// the stale v1 draft; approving that card clears v1, not the resubmitted v2.
// This test proves the list can show the stale v1 copy after a resubmit
// stores pending v1 but returns unstored v2 — and pins the UI-side guard:
// the list must flag a queued copy that disagrees with the persisted
// journal head instead of silently presenting it as decidable.
//
// The assertions hold both before the server fix (flag present) and after
// it (list shows the true v2 draft, no flag), so the test stays green
// whichever lands first.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-r361-ui-guard-"));
  const dbFile = join(directory, "room.sqlite");
  const state = { directory, dbFile, store: null, server: null, origin: null };
  state.store = new RoomStore(dbFile);
  state.store.initialize(initialRoom("commons"));
  const agentRooms = new AgentRooms(state.store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });
  const humanKey = state.store.issueAccessKey("commons", "owner");
  const agent = state.store.identities.create("Collab Agent");
  state.store.identities.link(humanKey, "commons", { identityId: agent.identityId,
    displayName: "Collab Agent", permissions: ["accept_work"] });
  Object.assign(state, { humanKey, agent });
  state.serve = async () => {
    const server = createRoomServer({ store: state.store });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    state.server = server;
    state.origin = "http://127.0.0.1:" + server.address().port;
  };
  state.closeServer = async () => {
    if (!state.server) return;
    state.server.closeStreams(); state.server.closeAllConnections();
    await new Promise(resolve => state.server.close(resolve));
    state.server = null;
  };
  t.after(async () => {
    await state.closeServer();
    state.store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return state;
}

const bearer = token => ({ Authorization: "Bearer " + token });
const jsonHeaders = token => ({ ...bearer(token), "Content-Type": "application/json" });
const post = (f, path, token, body) => fetch(f.origin + path,
  { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(body) });
const get = (f, path, token) => fetch(f.origin + path, { headers: bearer(token) });
const agentIdOf = f => f.agent.identityId;

test("R36-1: the approvals list flags a stale queued copy after resubmit returns unstored v2", async t => {
  const f = setup(t); await f.serve();
  const base = "/api/rooms/commons/collab";
  const agentToken = f.agent.secret;
  // Agent proposes draft v1.
  const proposed = await (await post(f, `${base}/approvals`, agentToken,
    { threadId: "thread-ui", draft: { body: "v1 body" }, channel: "email" })).json();
  const proposalId = proposed.proposal.proposalId;
  assert.equal(proposed.proposal.version, 1);
  // Human asks for edits.
  const edited = await post(f, `${base}/approvals/${proposalId}/decide`, f.humanKey,
    { decision: "edit", editedBody: "rewrite the opening", note: "tone" });
  assert.equal(edited.status, 200);
  // Agent resubmits draft v2. The response carries the new revision...
  const resubmitted = await post(f, `${base}/approvals/${proposalId}/resubmit`, agentToken,
    { draft: { body: "v2 body" } });
  assert.equal(resubmitted.status, 200);
  const returned = (await resubmitted.json()).proposal;
  assert.equal(returned.version, 2, "resubmit response carries version 2");
  assert.equal(returned.draft.body, "v2 body", "resubmit response carries the new draft");
  // ...but the UI's read surface is the pending list. It must never
  // silently present the stale v1 queue copy as the decidable draft.
  const pending = (await (await get(f, `${base}/approvals?status=pending`, f.humanKey)).json())
    .proposals.find(p => p.proposalId === proposalId);
  assert.ok(pending, "resubmitted proposal is listed as pending");
  if (pending.draft.body === "v1 body" || pending.version === 1) {
    // Server has not persisted the resubmission (the R36-1 bug): the list
    // must flag the stale copy instead of rendering it blindly.
    assert.equal(pending.staleRevision, true,
      "list flags the stale queued copy rather than presenting v1 as current");
  } else {
    // Server fix landed: the list shows the true resubmitted revision.
    assert.equal(pending.version, 2);
    assert.equal(pending.draft.body, "v2 body");
  }
});

test("R36-1: an invalid resubmit that corrupts the queue is flagged on the list", async t => {
  const f = setup(t); await f.serve();
  const base = "/api/rooms/commons/collab";
  const agentToken = f.agent.secret;
  const proposed = await (await post(f, `${base}/approvals`, agentToken,
    { threadId: "thread-ui2", draft: { body: "v1 body" }, channel: "email" })).json();
  const proposalId = proposed.proposal.proposalId;
  await post(f, `${base}/approvals/${proposalId}/decide`, f.humanKey,
    { decision: "edit", editedBody: "rewrite", note: "tone" });
  // An invalid draft is rejected... (draftOf runs after move() mutates the
  // queue, so the queued copy flips to pending with the old draft).
  const bad = await post(f, `${base}/approvals/${proposalId}/resubmit`, agentToken,
    { draft: { body: 42 } });
  assert.equal(bad.status, 422);
  const listed = (await (await get(f, `${base}/approvals`, f.humanKey)).json())
    .proposals.find(p => p.proposalId === proposalId);
  assert.ok(listed, "proposal is still listed");
  const queueCorrupted = listed.status === "pending" && listed.version === 1;
  if (queueCorrupted) {
    assert.equal(listed.staleRevision, true,
      "list flags the corrupted queued copy rather than presenting it as a fresh pending draft");
  } else {
    // Server fix landed (validation before the move): the proposal is still
    // changes_requested at version 1 with no flag.
    assert.equal(listed.status, "changes_requested");
    assert.equal(listed.version, 1);
  }
});
