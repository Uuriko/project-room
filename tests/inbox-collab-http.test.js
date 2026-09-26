// Lane C inbox collaboration HTTP routes (task RC-2026-09-18-011), over a
// real store and a real HTTP server: assignments, internal notes (with the
// non-leakage invariant), draft locks, approvals (an agent can never clear
// its own draft), routing, and handoffs — plus restart persistence, room
// scoping, and the typed error codes.
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
import { assertNoInternal } from "../server/inbox-internal-notes.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-collab-http-"));
  const dbFile = join(directory, "room.sqlite");
  const state = { directory, dbFile, store: null, server: null, origin: null };
  state.store = new RoomStore(dbFile);
  state.store.initialize(initialRoom("commons"));
  // A second room owned by an agent, with no human account bindings at all:
  // the handoff_no_account_scope path and the room-scoping checks.
  state.store.db.exec(agentRoomSchema);
  const agentRooms = new AgentRooms(state.store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });
  const denIdentity = state.store.identities.create("Den Agent");
  agentRooms.create(denIdentity.secret, { roomId: "agent-den", title: "Den",
    purpose: "An agent-owned room.", kind: "personal", displayName: "Den Keeper" });
  const humanKey = state.store.issueAccessKey("commons", "owner");
  const agent = state.store.identities.create("Collab Agent");
  state.store.identities.link(humanKey, "commons", { identityId: agent.identityId,
    displayName: "Collab Agent", permissions: ["accept_work"] });
  const agent2 = state.store.identities.create("Second Agent");
  state.store.identities.link(humanKey, "commons", { identityId: agent2.identityId,
    displayName: "Second Agent", permissions: ["accept_work"] });
  Object.assign(state, { humanKey, agent, agent2, denIdentity });
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
  // Close and reopen the store file: the writable open must replay every
  // collab journal from SQLite.
  state.reopen = async () => {
    await state.closeServer();
    state.store.close();
    state.store = new RoomStore(dbFile);
    await state.serve();
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
const codeOf = async response => (await response.json()).error.code;
const agentIdOf = f => f.agent.identityId;
const agent2IdOf = f => f.agent2.identityId;

test("assignments: assign, list, release, and conflicts", async t => {
  const f = setup(t); await f.serve();
  const base = "/api/rooms/commons/collab";
  // Assign the thread to the agent.
  const assigned = await post(f, `${base}/assignments`, f.humanKey,
    { threadId: "thread-a", assignee: { kind: "agent", id: agentIdOf(f) } });
  assert.equal(assigned.status, 201);
  const { assignmentId, assignment } = await assigned.json();
  assert.ok(typeof assignmentId === "string");
  assert.equal(assignment.threadId, "thread-a");
  assert.equal(assignment.status, "assigned");
  assert.equal(assignment.assignee.id, agentIdOf(f));
  // The list carries the wrapper-level assignmentId.
  const listed = await (await get(f, `${base}/assignments`, f.humanKey)).json();
  assert.equal(listed.assignments.length, 1);
  assert.equal(listed.assignments[0].assignmentId, assignmentId);
  // Assigning elsewhere without force is a 409; force by a human takes over.
  const conflict = await post(f, `${base}/assignments`, f.humanKey,
    { threadId: "thread-a", assignee: { kind: "human", id: "owner" } });
  assert.equal(conflict.status, 409);
  assert.equal(await codeOf(conflict), "assign_conflict");
  const forced = await post(f, `${base}/assignments`, f.humanKey,
    { threadId: "thread-a", assignee: { kind: "human", id: "owner" }, force: true });
  assert.equal(forced.status, 201);
  assert.equal((await forced.json()).assignment.assignee.id, "owner");
  // Release by id; releasing twice is 404 assign_not_assigned.
  const released = await post(f, `${base}/assignments/${assignmentId}/release`, f.humanKey, { reason: "done" });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).assignment.status, "released");
  const again = await post(f, `${base}/assignments/${assignmentId}/release`, f.humanKey, {});
  assert.equal(again.status, 404);
  assert.equal(await codeOf(again), "assign_not_assigned");
  const unknown = await post(f, `${base}/assignments/nope/release`, f.humanKey, {});
  assert.equal(unknown.status, 404);
  assert.equal(await codeOf(unknown), "assignment_not_found");
  // Bad shapes are 422, not 500.
  const bad = await post(f, `${base}/assignments`, f.humanKey, { threadId: "", assignee: { kind: "agent", id: agentIdOf(f) } });
  assert.equal(bad.status, 422);
  assert.equal(await codeOf(bad), "assign_invalid");
});

test("internal notes: add, list, and the non-leakage invariant", async t => {
  const f = setup(t); await f.serve();
  const base = "/api/rooms/commons/collab";
  const marker = "SECRET-NOTE-MARKER-9f31";
  const created = await post(f, `${base}/notes`, f.humanKey,
    { threadId: "thread-n", body: `do not leak: ${marker}`, tag: "handoff" });
  assert.equal(created.status, 201);
  const { note } = await created.json();
  assert.ok(typeof note.noteId === "string");
  assert.equal(note.internal, true);
  assert.equal(note.body, `do not leak: ${marker}`);
  const listed = await (await get(f, `${base}/notes?threadId=thread-n`, f.humanKey)).json();
  assert.equal(listed.notes.length, 1);
  assert.equal(listed.notes[0].noteId, note.noteId);
  // threadId is required on the list route.
  const missing = await get(f, `${base}/notes`, f.humanKey);
  assert.equal(missing.status, 422);
  // The note must not appear in ordinary room/channel-facing payloads.
  const snapshot = await (await get(f, "/api/rooms/commons", f.humanKey)).json();
  assert.ok(!JSON.stringify(snapshot).includes(marker), "note body leaked into the room snapshot");
  assert.ok(!JSON.stringify(snapshot).includes("internalNote"), "note field leaked into the room snapshot");
  const events = await (await get(f, "/api/rooms/commons/events?limit=100", f.humanKey)).json();
  assert.ok(!JSON.stringify(events).includes(marker), "note body leaked into room events");
  // The tripwire itself: assertNoInternal accepts clean channel payloads and
  // rejects anything carrying an internal note.
  assert.doesNotThrow(() => assertNoInternal({ text: "hello", attachments: [] }));
  assert.throws(() => assertNoInternal({ note }), err => err.code === "note_contract_violation");
  // And the positive control: the note IS readable through the collab route.
  const again = await (await get(f, `${base}/notes?threadId=thread-n`, f.humanKey)).json();
  assert.ok(JSON.stringify(again).includes(marker));
});

test("draft locks: agent acquire, collisions, detect, release", async t => {
  const f = setup(t); await f.serve();
  const base = "/api/rooms/commons/collab";
  const agentToken = f.agent.secret, agent2Token = f.agent2.secret;
  const acquired = await post(f, `${base}/draft-locks/acquire`, agentToken, { threadId: "thread-l" });
  assert.equal(acquired.status, 201);
  const { lock, duplicate } = await acquired.json();
  assert.equal(duplicate, false);
  assert.ok(typeof lock.lockId === "string");
  assert.equal(lock.holder.id, agentIdOf(f));
  // Same holder re-acquiring refreshes (200 duplicate:true); a different
  // agent collides with 409.
  const refresh = await post(f, `${base}/draft-locks/acquire`, agentToken, { threadId: "thread-l" });
  assert.equal(refresh.status, 200);
  assert.equal((await refresh.json()).duplicate, true);
  const collision = await post(f, `${base}/draft-locks/acquire`, agent2Token, { threadId: "thread-l" });
  assert.equal(collision.status, 409);
  assert.equal(await codeOf(collision), "collision_lock_held");
  // A human cannot acquire a draft lock at all.
  const humanAcquire = await post(f, `${base}/draft-locks/acquire`, f.humanKey, { threadId: "thread-l" });
  assert.equal(humanAcquire.status, 403);
  assert.equal(await codeOf(humanAcquire), "agent_required");
  // Detect names the other holder; the holder itself sees no collision.
  const detected = await (await get(f, `${base}/draft-locks?threadId=thread-l`, agent2Token)).json();
  assert.equal(detected.collision, true);
  assert.equal(detected.holders[0].id, agentIdOf(f));
  const selfDetect = await (await get(f, `${base}/draft-locks?threadId=thread-l`, agentToken)).json();
  assert.equal(selfDetect.collision, false);
  // Only the holder may release; afterwards the thread is free.
  const forbidden = await post(f, `${base}/draft-locks/release`, agent2Token, { lockId: lock.lockId });
  assert.equal(forbidden.status, 403);
  assert.equal(await codeOf(forbidden), "collision_forbidden");
  const released = await post(f, `${base}/draft-locks/release`, agentToken, { lockId: lock.lockId });
  assert.equal(released.status, 200);
  assert.deepEqual(await released.json(), { released: true, lockId: lock.lockId });
  const free = await post(f, `${base}/draft-locks/acquire`, agent2Token, { threadId: "thread-l" });
  assert.equal(free.status, 201);
  // The freed thread is now held by the second agent.
  const afterDetect = await (await get(f, `${base}/draft-locks?threadId=thread-l`, agentToken)).json();
  assert.equal(afterDetect.holders[0].id, agent2IdOf(f));
  const unknown = await post(f, `${base}/draft-locks/release`, agentToken, { lockId: "nope" });
  assert.equal(unknown.status, 404);
  assert.equal(await codeOf(unknown), "lock_not_found");
});

test("approvals: propose, human decide, agent self-approval refused", async t => {
  const f = setup(t); await f.serve();
  const base = "/api/rooms/commons/collab";
  const agentToken = f.agent.secret;
  const draft = { subject: "Re: hello", body: "Here is a draft reply." };
  // A human cannot propose; only agents propose.
  const humanPropose = await post(f, `${base}/approvals`, f.humanKey,
    { threadId: "thread-p", draft, channel: "email" });
  assert.equal(humanPropose.status, 403);
  assert.equal(await codeOf(humanPropose), "agent_required");
  const proposed = await post(f, `${base}/approvals`, agentToken,
    { threadId: "thread-p", draft, channel: "email" });
  assert.equal(proposed.status, 201);
  const { proposal } = await proposed.json();
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.byAgent.id, agentIdOf(f));
  const proposalId = proposal.proposalId;
  // The proposing agent cannot clear its own draft: 403 before the queue.
  const selfApprove = await post(f, `${base}/approvals/${proposalId}/decide`, agentToken,
    { decision: "approve" });
  assert.equal(selfApprove.status, 403);
  // RC-2026-09-18-023: the denial explains the boundary and the unlock.
  const denial = await selfApprove.json();
  assert.equal(denial.error.code, "human_required");
  assert.ok(denial.error.message.includes("cannot clear its own draft"),
    "denial states the trust boundary");
  assert.ok(denial.error.message.includes("/collab/approvals/"),
    "denial names the verdict call a human must make");
  // A human approves.
  const approved = await post(f, `${base}/approvals/${proposalId}/decide`, f.humanKey,
    { decision: "approve", note: "looks good" });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).proposal.status, "approved");
  // Terminal proposals refuse further verdicts with 409.
  const late = await post(f, `${base}/approvals/${proposalId}/decide`, f.humanKey, { decision: "reject", note: "x" });
  assert.equal(late.status, 409);
  assert.equal(await codeOf(late), "approval_transition");
  // The edit → resubmit → reject lifecycle on a second proposal.
  const second = await (await post(f, `${base}/approvals`, agentToken,
    { threadId: "thread-p2", draft, channel: "email" })).json();
  const edited = await post(f, `${base}/approvals/${second.proposal.proposalId}/decide`, f.humanKey,
    { decision: "edit", editedBody: "Soften the opening line.", note: "tone" });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).proposal.status, "changes_requested");
  // edit without editedBody is 422.
  const badEdit = await post(f, `${base}/approvals/${second.proposal.proposalId}/decide`, f.humanKey,
    { decision: "edit" });
  assert.equal(badEdit.status, 422);
  // The agent resubmits; only agents resubmit.
  const humanResubmit = await post(f, `${base}/approvals/${second.proposal.proposalId}/resubmit`, f.humanKey,
    { draft: { body: "Softer opening." } });
  assert.equal(humanResubmit.status, 403);
  const resubmitted = await post(f, `${base}/approvals/${second.proposal.proposalId}/resubmit`, agentToken,
    { draft: { body: "Softer opening." } });
  assert.equal(resubmitted.status, 200);
  assert.equal((await resubmitted.json()).proposal.status, "pending");
  const rejected = await post(f, `${base}/approvals/${second.proposal.proposalId}/decide`, f.humanKey,
    { decision: "reject", note: "not this time" });
  assert.equal(rejected.status, 200);
  assert.equal((await rejected.json()).proposal.status, "rejected");
  // Unknown proposals and bad decisions.
  const unknown = await post(f, `${base}/approvals/nope/decide`, f.humanKey, { decision: "approve" });
  assert.equal(unknown.status, 404);
  assert.equal(await codeOf(unknown), "approval_not_found");
  const badDecision = await post(f, `${base}/approvals/${proposalId}/decide`, f.humanKey, { decision: "maybe" });
  assert.equal(badDecision.status, 422);
  // List with a status filter; unknown statuses are 422.
  const pending = await (await get(f, `${base}/approvals?status=pending`, f.humanKey)).json();
  assert.ok(pending.proposals.every(p => p.status === "pending"));
  const badStatus = await get(f, `${base}/approvals?status=napping`, f.humanKey);
  assert.equal(badStatus.status, 422);
  assert.equal(await codeOf(badStatus), "approval_invalid");
});

test("routing: mentions, list, resolve, policy", async t => {
  const f = setup(t); await f.serve();
  const base = "/api/rooms/commons/collab";
  const routed = await post(f, `${base}/routing/mentions`, f.humanKey,
    { mentionedAgentId: "claude", threadId: "thread-r", context: "needs eyes" });
  assert.equal(routed.status, 201);
  const { records, mentions } = await routed.json();
  assert.deepEqual(mentions, ["claude"]);
  assert.equal(records.length, 1);
  assert.equal(records[0].agent, "claude");
  assert.equal(records[0].status, "routed");
  const routingId = records[0].routingId;
  const listed = await (await get(f, `${base}/routing`, f.humanKey)).json();
  assert.equal(listed.records.length, 1);
  assert.equal(listed.records[0].routingId, routingId);
  // The resolver is whoever authenticated, and nothing in the body may say
  // otherwise. Every other actor on these routes comes from the credential;
  // this one used to take the body's word for it, so any member could record
  // the owner, or anyone else, as having resolved a routed mention, in the
  // durable journal as well as the response.
  const forged = await post(f, `${base}/routing/${routingId}/resolve`, f.humanKey,
    { outcome: "not mine to claim", resolvedBy: { kind: "human", id: "guest", label: "Guest" } });
  assert.equal(forged.status, 422, "there is no field that chooses who resolved this");
  assert.equal(await codeOf(forged), "invalid_input");
  const untouched = await (await get(f, `${base}/routing`, f.humanKey)).json();
  assert.equal(untouched.records[0].status, "routed", "the refusal recorded nothing");

  // Resolve hoists the outcome onto the record view.
  const resolved = await post(f, `${base}/routing/${routingId}/resolve`, f.humanKey,
    { outcome: "claude picked it up" });
  assert.equal(resolved.status, 200);
  const { record } = await resolved.json();
  assert.equal(record.status, "resolved");
  assert.equal(record.outcome, "claude picked it up");
  assert.equal(record.resolvedBy.id, "owner");
  const unknown = await post(f, `${base}/routing/nope/resolve`, f.humanKey, { outcome: "x" });
  assert.equal(unknown.status, 404);
  assert.equal(await codeOf(unknown), "routing_not_found");
  // Policies: direct is the default mode; unknown modes are 422.
  const policy = await post(f, `${base}/routing/policy`, f.humanKey,
    { agentId: "claude", policy: { mode: "escalate", escalateTo: { kind: "human", id: "owner" }, note: "route up" } });
  assert.equal(policy.status, 200);
  assert.equal((await policy.json()).policy.mode, "escalate");
  const badPolicy = await post(f, `${base}/routing/policy`, f.humanKey,
    { agentId: "claude", policy: { mode: "teleport" } });
  assert.equal(badPolicy.status, 422);
  assert.equal(await codeOf(badPolicy), "routing_invalid");
  const badMention = await post(f, `${base}/routing/mentions`, f.humanKey, { mentionedAgentId: "not a name!" });
  assert.equal(badMention.status, 422);
});

test("handoffs: room-scoped journal writes with account resolution", async t => {
  const f = setup(t); await f.serve();
  const base = "/api/rooms/commons/collab";
  const created = await post(f, `${base}/handoffs`, f.humanKey,
    { threadId: "thread-h", to: { kind: "agent", id: "claude" }, summary: "Needs a person." });
  assert.equal(created.status, 201);
  const { duplicate, handoff } = await created.json();
  assert.equal(duplicate, false);
  assert.equal(handoff.status, "open");
  assert.equal(handoff.packet.to, "claude");
  assert.equal(handoff.packet.channel, "room");
  assert.equal(handoff.packet.summary, "Needs a person.");
  // A second create for the same thread returns the existing open handoff.
  const repeat = await post(f, `${base}/handoffs`, f.humanKey,
    { threadId: "thread-h", to: { kind: "agent", id: "grokbot" } });
  assert.equal(repeat.status, 200);
  const again = await repeat.json();
  assert.equal(again.duplicate, true);
  assert.equal(again.handoff.handoffId, handoff.handoffId);
  // List and transition through the room route.
  const listed = await (await get(f, `${base}/handoffs`, f.humanKey)).json();
  assert.equal(listed.handoffs.length, 1);
  const accepted = await post(f, `${base}/handoffs/${handoff.handoffId}/transition`, f.humanKey,
    { status: "accepted", note: "on it" });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).handoff.status, "accepted");
  const illegal = await post(f, `${base}/handoffs/${handoff.handoffId}/transition`, f.humanKey,
    { status: "napping" });
  assert.equal(illegal.status, 422);
  // The agent-owned room has no human account bindings anywhere: 409 with
  // the stable handoff_no_account_scope code.
  const denBase = "/api/rooms/agent-den/collab";
  const scoped = await post(f, `${denBase}/handoffs`, f.denIdentity.secret,
    { threadId: "thread-h2", to: { kind: "agent", id: "claude" } });
  assert.equal(scoped.status, 409);
  assert.equal(await codeOf(scoped), "handoff_no_account_scope");
  const scopedList = await get(f, `${denBase}/handoffs`, f.denIdentity.secret);
  assert.equal(scopedList.status, 409);
  assert.equal(await codeOf(scopedList), "handoff_no_account_scope");

  // An agent member of a room with a human owner works under the owner's
  // account, but only inside this room. inbox_handoffs is keyed on account
  // alone, so before the room scope that account opened the owner's handoffs
  // in EVERY room they own. Here the owner has a second handoff in another
  // room of the same account, recorded straight into the journal the way the
  // account inbox path writes it, and the agent must never see or move it.
  const ownerAccount = f.store.accountForMember("commons", "owner").id;
  const elsewhere = f.store.handoffs.create(ownerAccount,
    { threadId: "other-room-thread", channel: "room", sourceIds: ["other-room-thread"], sender: { id: "owner", label: "owner" },
      subject: "OTHER-ROOM-PRIVATE", occurredAt: new Date().toISOString(), sla: null,
      triage: { action: "needs_human", reasons: ["elsewhere"] }, summary: "OTHER-ROOM-SUMMARY" },
    { from: "owner", to: "claude", recordRoom: "some-other-room" }).receipt;

  const agentView = await get(f, `${base}/handoffs`, f.agent.secret);
  assert.equal(agentView.status, 200, "an agent still gets handoffs in its own room");
  const agentText = await agentView.text();
  assert.ok(agentText.includes(handoff.handoffId), "including the one the owner made in this room");
  assert.equal(agentText.includes("OTHER-ROOM-SUMMARY"), false, "and never another room's packet");
  assert.equal(agentText.includes(elsewhere.handoffId), false);

  const moved = await post(f, `${base}/handoffs/${elsewhere.handoffId}/transition`, f.agent.secret, { status: "released" });
  assert.equal(moved.status, 404, "another room's handoff answers exactly like one that does not exist");
  assert.equal(f.store.handoffs.list(ownerAccount).find(entry => entry.handoffId === elsewhere.handoffId).status, "open");

  // What an agent creates lands in this room, and the owner sees it.
  const agentMade = await post(f, `${base}/handoffs`, f.agent.secret,
    { threadId: "thread-agent", to: { kind: "human", id: "owner" }, summary: "Needs the owner." });
  assert.equal(agentMade.status, 201);
  const ownerView = await (await get(f, `${base}/handoffs`, f.humanKey)).json();
  assert.ok(ownerView.handoffs.some(entry => entry.threadId === "thread-agent"));
});

test("envelopes: typed delegation lifecycle, checks, sweep, and metrics", async t => {
  const f = setup(t); await f.serve();
  const base = "/api/rooms/commons/collab";
  const agentToken = f.agent.secret;
  const future = new Date(Date.now() + 86400000).toISOString();
  const envelope = {
    to: agentIdOf(f),
    objective: "Summarize the thread and draft a reply",
    inputs: [{ kind: "message", ref: "msg-1", label: "the thread" }],
    authority: { permissions: ["accept_work", "complete_work"], scope: { rooms: ["commons"] }, expiresAt: future },
    expectedOutput: { kind: "text_result", description: "A draft reply of at most 500 words" },
    acceptanceTest: { checks: [{ kind: "result_submitted", workId: "work-1" }] },
    termination: { expiresAt: future, onExpiry: "release" },
  };
  // A malformed envelope is 422: missing fields fail the shape check, and a
  // full-shaped but invalid envelope fails the journal validator.
  const bad = await post(f, `${base}/envelopes`, f.humanKey, { to: agentIdOf(f) });
  assert.equal(bad.status, 422);
  assert.equal(await codeOf(bad), "invalid_input");
  const bad2 = await post(f, `${base}/envelopes`, f.humanKey,
    { ...envelope, authority: { ...envelope.authority, permissions: ["manage_members"] } });
  assert.equal(bad2.status, 422);
  assert.equal(await codeOf(bad2), "invalid_handoff_envelope");
  const created = await post(f, `${base}/envelopes`, f.humanKey, envelope);
  assert.equal(created.status, 201);
  const { envelopeId, status, envelope: env } = await created.json();
  assert.ok(envelopeId.startsWith("he_"));
  assert.equal(status, "proposed");
  assert.equal(env.objective, envelope.objective);
  assert.equal(env.provenance.createdBy, "owner");
  // The recipient accepts; the sender cannot accept its own envelope.
  const selfAccept = await post(f, `${base}/envelopes/${envelopeId}/transition`, f.humanKey,
    { status: "accepted" });
  assert.equal(selfAccept.status, 403);
  assert.equal(await codeOf(selfAccept), "envelope_recipient_only");
  const accepted = await post(f, `${base}/envelopes/${envelopeId}/transition`, agentToken,
    { status: "accepted" });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).envelope.status, "accepted");
  // Completing without naming checks is 422; with the declared check it lands.
  const noChecks = await post(f, `${base}/envelopes/${envelopeId}/transition`, agentToken,
    { status: "completed" });
  assert.equal(noChecks.status, 422);
  assert.equal(await codeOf(noChecks), "envelope_checks_required");
  const done = await post(f, `${base}/envelopes/${envelopeId}/transition`, agentToken,
    { status: "completed", checksPassed: ["result_submitted"] });
  assert.equal(done.status, 200);
  assert.equal((await done.json()).envelope.status, "completed");
  // List filters; metrics names the escalation rate.
  const listed = await (await get(f, `${base}/envelopes?status=completed`, f.humanKey)).json();
  assert.equal(listed.envelopes.length, 1);
  assert.equal(listed.envelopes[0].envelopeId, envelopeId);
  const metrics = await (await get(f, `${base}/envelopes/metrics`, f.humanKey)).json();
  assert.equal(metrics.total, 1);
  assert.equal(metrics.closed, 1);
  assert.equal(metrics.escalationRate, 0);
  // The sweep is idempotent and returns what it moved.
  const swept = await (await post(f, `${base}/envelopes/sweep`, f.humanKey, {})).json();
  assert.deepEqual(swept.swept, { expired: [], escalated: [] });
});

test("envelopes: create retries survive lost responses, lifecycle changes and restart without duplicates", async t => {
  const f = setup(t); await f.serve();
  let now = Date.now(); f.store.now = () => now;
  const base = "/api/rooms/commons/collab/envelopes", deadline = now + 60000;
  const fields = {
    requestId: "handoff-retry-1", to: agentIdOf(f), objective: "Review the patch",
    inputs: [{ kind: "note", ref: "Patch context" }],
    authority: { permissions: ["accept_work"], scope: { rooms: ["commons"] }, expiresAt: new Date(deadline).toISOString() },
    expectedOutput: { kind: "report", description: "Review findings" },
    acceptanceTest: { checks: [{ kind: "manual_review", reviewer: agentIdOf(f) }] },
    termination: { expiresAt: new Date(deadline).toISOString(), onExpiry: "release" }
  };
  // Discard the committed creation response: the caller cannot know its ID.
  const lost = await post(f, base, f.humanKey, fields);
  assert.equal(lost.status, 201); await lost.body.cancel();
  const retry = await post(f, base, f.humanKey, fields);
  assert.equal(retry.status, 200);
  const receipt = await retry.json();
  assert.equal(receipt.duplicate, true);
  const { envelopeId } = receipt;
  assert.equal((await (await get(f, base, f.humanKey)).json()).envelopes.length, 1);
  assert.equal((await post(f, `${base}/${envelopeId}/transition`, f.agent.secret, { status: "accepted" })).status, 200);
  await f.reopen(); f.store.now = () => now;
  now = deadline + 1;
  const resumed = await (await post(f, base, f.humanKey, fields)).json();
  assert.equal(resumed.duplicate, true);
  assert.equal(resumed.envelopeId, envelopeId);
  assert.equal(resumed.status, "accepted");
  assert.equal(resumed.createdAt, receipt.createdAt);
  assert.equal(resumed.history.length, 2);
  await post(f, `${base}/sweep`, f.humanKey, {});
  const expired = await (await post(f, base, f.humanKey, fields)).json();
  assert.equal(expired.status, "expired");
  assert.equal(expired.duplicate, true);
  const conflict = await post(f, base, f.humanKey, { ...fields, objective: "Different patch" });
  assert.equal(conflict.status, 409);
  assert.equal(await codeOf(conflict), "envelope_request_conflict");
  assert.deepEqual((await (await get(f, base, f.humanKey)).json()).envelopes[0],
    Object.fromEntries(Object.entries(expired).filter(([key]) => key !== "duplicate")));

  now = deadline - 1;
  const concurrentFields = { ...fields, requestId: "concurrent-create" };
  const responses = await Promise.all(Array.from({ length: 4 }, () => post(f, base, f.humanKey, concurrentFields)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 200, 201]);
  const receipts = await Promise.all(responses.map(response => response.json()));
  assert.equal(new Set(receipts.map(row => row.envelopeId)).size, 1);
  assert.equal(receipts.filter(row => row.duplicate === false).length, 1);
  // JSON property order is immaterial; normalized optional defaults are stable.
  const reordered = Object.fromEntries(Object.entries({ ...concurrentFields, provenance: { chain: [] } }).reverse());
  assert.equal((await post(f, base, f.humanKey, reordered)).status, 200);
  const otherActor = await post(f, base, f.agent2.secret, concurrentFields);
  assert.equal(otherActor.status, 201);
  assert.notEqual((await otherActor.json()).envelopeId, receipts[0].envelopeId);
  f.store.initialize(initialRoom("other-room"));
  const otherKey = f.store.issueAccessKey("other-room", "owner");
  const otherRoom = await post(f, "/api/rooms/other-room/collab/envelopes", otherKey, concurrentFields);
  assert.equal(otherRoom.status, 201);
  assert.notEqual((await otherRoom.json()).envelopeId, receipts[0].envelopeId);
  const { requestId: _requestId, ...legacy } = fields;
  const legacyReceipts = [];
  for (let i = 0; i < 2; i++) {
    const response = await post(f, base, f.humanKey, legacy);
    assert.equal(response.status, 201); legacyReceipts.push(await response.json());
  }
  assert.notEqual(legacyReceipts[0].envelopeId, legacyReceipts[1].envelopeId);
  assert.equal(Object.hasOwn(legacyReceipts[0], "duplicate"), false);
  for (const requestId of [null, "", 7, "bad id", "a".repeat(129)]) {
    assert.equal((await post(f, base, f.humanKey, { ...fields, requestId })).status, 422);
  }
});

// HTTP is the primary regression boundary: configured deadlines must be
// enforced without relying on a separately invoked maintenance sweep.
test("envelopes: configured expiry blocks late acceptance/completion but allows cleanup", async t => {
  const f = setup(t); await f.serve();
  const base = "/api/rooms/commons/collab/envelopes", initial = Date.now();
  let now = initial; f.store.now = () => now;
  const deadline = initial + 60000, later = deadline + 60000;
  for (const humanRecipient of [false, true]) {
    const sender = humanRecipient ? f.agent.secret : f.humanKey;
    const recipient = humanRecipient ? f.humanKey : f.agent.secret;
    for (const expires of ["authority", "termination"]) {
      for (const status of ["accepted", "completed"]) {
        for (const offset of [-1, 0, 1]) {
          now = initial;
          const created = await post(f, base, sender, {
            to: humanRecipient ? "owner" : agentIdOf(f), objective: "Review this handoff",
            inputs: [{ kind: "note", ref: "Current work context" }],
            authority: { permissions: ["accept_work"], scope: { rooms: ["commons"] },
              expiresAt: new Date(expires === "authority" ? deadline : later).toISOString() },
            expectedOutput: { kind: "report", description: "A reviewed result" },
            acceptanceTest: { checks: [{ kind: "manual_review", reviewer: humanRecipient ? "owner" : agentIdOf(f) }] },
            termination: { expiresAt: new Date(expires === "termination" ? deadline : later).toISOString(), onExpiry: "release" }
          });
          assert.equal(created.status, 201);
          const { envelopeId } = await created.json();
          const transition = (value, token = recipient) => post(f, `${base}/${envelopeId}/transition`, token, value);
          if (status === "completed") assert.equal((await transition({ status: "accepted" })).status, 200);
          const before = f.store.handoffEnvelopes.list("commons").find(row => row.envelopeId === envelopeId);
          now = deadline + offset;
          const response = await transition({ status, ...(status === "completed" ? { checksPassed: ["manual_review"] } : {}) });
          const label = `${humanRecipient ? "human" : "agent"} ${status} at ${expires} deadline ${offset}`;
          assert.equal(response.status, offset < 0 ? 200 : 409, label);
          if (offset < 0) { assert.equal((await response.json()).envelope.status, status); continue; }
          assert.equal(await codeOf(response), "envelope_expired", label);
          assert.deepEqual(f.store.handoffEnvelopes.list("commons").find(row => row.envelopeId === envelopeId), before,
            "late transition leaves the journal unchanged for explicit cleanup");
          const cleanup = status === "accepted" ? "cancelled" : "escalated";
          assert.equal((await transition({ status: cleanup }, sender)).status, 200, "sender can still clean up expired work");
        }
      }
    }
  }
});

test("restart persistence: every journal replays from SQLite", async t => {
  const f = setup(t); await f.serve();
  const base = "/api/rooms/commons/collab";
  const agentToken = f.agent.secret, agent2Token = f.agent2.secret;
  const { assignmentId } = await (await post(f, `${base}/assignments`, f.humanKey,
    { threadId: "thread-restart", assignee: { kind: "agent", id: agentIdOf(f) } })).json();
  const { note } = await (await post(f, `${base}/notes`, f.humanKey,
    { threadId: "thread-restart", body: "persist me" })).json();
  const { lock } = await (await post(f, `${base}/draft-locks/acquire`, agentToken,
    { threadId: "thread-restart", ttlMs: 600000 })).json();
  assert.ok(typeof lock.lockId === "string");
  const { proposal } = await (await post(f, `${base}/approvals`, agentToken,
    { threadId: "thread-restart", draft: { body: "draft" }, channel: "email" })).json();
  const { records } = await (await post(f, `${base}/routing/mentions`, f.humanKey,
    { mentionedAgentId: "claude", threadId: "thread-restart" })).json();
  await post(f, `${base}/handoffs`, f.humanKey,
    { threadId: "thread-restart", to: { kind: "agent", id: "claude" } });
  await f.reopen();
  // Assignments, notes, locks, approvals, routing all survived the restart.
  const assignments = await (await get(f, `${base}/assignments`, f.humanKey)).json();
  assert.equal(assignments.assignments.length, 1);
  assert.equal(assignments.assignments[0].assignmentId, assignmentId);
  assert.equal(assignments.assignments[0].status, "assigned");
  const notes = await (await get(f, `${base}/notes?threadId=thread-restart`, f.humanKey)).json();
  assert.equal(notes.notes.length, 1);
  assert.equal(notes.notes[0].noteId, note.noteId);
  assert.equal(notes.notes[0].body, "persist me");
  // The replayed lock still blocks a stranger and still belongs to its holder.
  const blocked = await post(f, `${base}/draft-locks/acquire`, agent2Token, { threadId: "thread-restart" });
  assert.equal(blocked.status, 409);
  assert.equal(await codeOf(blocked), "collision_lock_held");
  const detect = await (await get(f, `${base}/draft-locks?threadId=thread-restart`, agentToken)).json();
  assert.equal(detect.collision, false);
  const approvals = await (await get(f, `${base}/approvals`, f.humanKey)).json();
  assert.equal(approvals.proposals.length, 1);
  assert.equal(approvals.proposals[0].proposalId, proposal.proposalId);
  assert.equal(approvals.proposals[0].status, "pending");
  const routing = await (await get(f, `${base}/routing`, f.humanKey)).json();
  assert.equal(routing.records.length, 1);
  assert.equal(routing.records[0].routingId, records[0].routingId);
  const handoffs = await (await get(f, `${base}/handoffs`, f.humanKey)).json();
  assert.equal(handoffs.handoffs.length, 1);
  assert.equal(handoffs.handoffs[0].threadId, "thread-restart");
  // And the replayed state keeps working: release the assignment by id.
  const released = await post(f, `${base}/assignments/${assignmentId}/release`, f.humanKey, {});
  assert.equal(released.status, 200);
});

test("room scoping: collab data never crosses rooms", async t => {
  const f = setup(t); await f.serve();
  const commons = "/api/rooms/commons/collab";
  const den = "/api/rooms/agent-den/collab";
  await post(f, `${commons}/assignments`, f.humanKey,
    { threadId: "thread-scope", assignee: { kind: "agent", id: agentIdOf(f) } });
  await post(f, `${den}/assignments`, f.denIdentity.secret,
    { threadId: "thread-scope", assignee: { kind: "agent", id: f.denIdentity.identityId } });
  const commonsList = await (await get(f, `${commons}/assignments`, f.humanKey)).json();
  assert.equal(commonsList.assignments.length, 1);
  assert.equal(commonsList.assignments[0].assignee.id, agentIdOf(f));
  const denList = await (await get(f, `${den}/assignments`, f.denIdentity.secret)).json();
  assert.equal(denList.assignments.length, 1);
  assert.equal(denList.assignments[0].assignee.id, f.denIdentity.identityId);
  // Notes are room-scoped too.
  await post(f, `${commons}/notes`, f.humanKey, { threadId: "thread-scope", body: "commons only" });
  const denNotes = await (await get(f, `${den}/notes?threadId=thread-scope`, f.denIdentity.secret)).json();
  assert.equal(denNotes.notes.length, 0);
  // A commons member cannot reach the den's collab routes at all.
  const forbidden = await get(f, `${den}/assignments`, f.humanKey);
  assert.ok([401, 403].includes(forbidden.status), `expected 401/403, got ${forbidden.status}`);
});
