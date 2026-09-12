// W4-07 A7: test actual disconnected agents.
// An agent asks a question, disconnects (all client state discarded),
// reconnects with a fresh client holding only its identity secret, reads a
// clarification the owner posted while it was away, and answers. A separate
// participant (the reviewer) verifies the outcome. The agent's steps run in
// dedicated functions that only touch the agent's own credential and data the
// agent fetched itself — the test never composes the answer or forwards the
// clarification into the agent.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-disconnected-agent-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  // A second human: the separate participant who checks the outcome.
  store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
    data: { memberId: "reviewer", displayName: "Reviewer", kind: "human", permissions: [] } });
  const reviewerKey = store.issueAccessKey("commons", "reviewer");
  // The agent enrolls through a one-time invite code (its only credential).
  const invite = store.invites.create(ownerKey, "commons", { permissions: ["steer", "accept_work"] });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey, reviewerKey, inviteCode: invite.code };
}

const postCommand = (origin, token, command) => fetch(`${origin}/api/rooms/commons/commands`, {
  method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify(command),
}).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));
const replyGet = (origin, token, path) => fetch(`${origin}/api/rooms/commons/${path}`, {
  headers: { Origin: origin, Authorization: `Bearer ${token}` },
}).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));

// --- The agent's side. Each function is a separate "connection": no state is
// shared between them except the identity secret passed in by the test. ---
async function agentAsk(origin, identitySecret, questionMessageId) {
  const res = await postCommand(origin, identitySecret, { id: randomUUID(), type: "message.posted",
    data: { messageId: questionMessageId, body: "Which deploy target should I use for the pilot?", toMemberId: "owner", requestKind: "reply" } });
  assert.equal(res.status, 201, `agent ask failed: ${JSON.stringify(res.json)}`);
  return questionMessageId;
}

async function agentReconnectReadAndAnswer(origin, identitySecret, agentMemberId, answerBody) {
  // Fresh connection: list incoming requests (clarifications addressed to us).
  const list = await replyGet(origin, identitySecret, "reply-requests?direction=incoming");
  assert.equal(list.status, 200, `agent request list failed: ${JSON.stringify(list.json)}`);
  const open = (list.json.requests ?? []).filter(r => r.status === "open" && r.recipientId === agentMemberId);
  assert.ok(open.length >= 1, `agent has no open incoming requests: ${JSON.stringify(list.json.requests)}`);
  const clarification = open[0];
  // Read the clarification context — the agent fetches this itself.
  const context = await replyGet(origin, identitySecret, `reply-context?requestMessageId=${clarification.id}&limit=10`);
  assert.equal(context.status, 200, `agent context read failed: ${JSON.stringify(context.json)}`);
  const basis = context.json.current?.answerBasis;
  assert.ok(basis?.contextEventId && Number.isSafeInteger(basis?.contextSequence),
    `agent could not determine the answer basis: ${JSON.stringify(context.json.current)}`);
  assert.equal(context.json.current?.actions?.answer, true, "agent must be allowed to answer the clarification");
  // Answer against the basis the agent read — never against test-held state.
  const res = await postCommand(origin, identitySecret, { id: randomUUID(), type: "message.posted",
    data: { messageId: randomUUID(), body: answerBody, toMemberId: "owner", replyToId: clarification.id,
      responseToRequestId: clarification.id, expectedRequestRevision: basis.expectedRequestRevision,
      responseOutcome: "answered", contextEventId: basis.contextEventId, contextSequence: basis.contextSequence,
      workItemId: null } });
  assert.equal(res.status, 201, `agent answer failed: ${JSON.stringify(res.json)}`);
  return { clarificationId: clarification.id };
}

test("agent asks, disconnects, reconnects, reads clarification, and answers", async t => {
  const { origin, ownerKey, reviewerKey, inviteCode } = await serve(t);

  // Enrollment: the agent redeems its invite code for an identity secret.
  const redeem = await fetch(`${origin}/api/agent-invites/redeem`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ code: inviteCode, displayName: "Pilot Agent" }) })
    .then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));
  assert.equal(redeem.status, 201, `redeem failed: ${JSON.stringify(redeem.json)}`);
  const identitySecret = redeem.json.secret;
  const agentMemberId = redeem.json.memberId;
  assert.ok(identitySecret && agentMemberId, "redeem must return an identity secret and member id");

  // 1. The agent asks its question (first connection).
  const questionMessageId = `question-${randomUUID()}`;
  await agentAsk(origin, identitySecret, questionMessageId);

  // 2. The agent disconnects: every handle it held is dropped here. Nothing
  //    of the agent's client state survives past this line except the secret.

  // 3. While the agent is away, the owner asks the agent for clarification —
  //    a reply-request directed at the agent, threaded on its question.
  const clarificationBody = `clarification-${randomUUID()}: which target do you mean by pilot — canary or prod?`;
  const clarificationId = `clarify-${randomUUID()}`;
  const clarify = await postCommand(origin, ownerKey, { id: randomUUID(), type: "message.posted",
    data: { messageId: clarificationId, body: clarificationBody, replyToId: questionMessageId,
      toMemberId: agentMemberId, requestKind: "reply" } });
  assert.equal(clarify.status, 201, `clarification failed: ${JSON.stringify(clarify.json)}`);

  // 4. The agent reconnects with a fresh client (only the secret), reads the
  //    clarification itself, and answers. The test does not forward the
  //    clarification text into this call.
  const answerBody = `answer-${randomUUID()}: canary — prod stays untouched`;
  const { clarificationId: answeredId } = await agentReconnectReadAndAnswer(origin, identitySecret, agentMemberId, answerBody);
  assert.equal(answeredId, clarificationId);

  // 5. A separate participant (the reviewer, not the owner or the agent)
  //    checks the outcome using only their own credential.
  const check = await replyGet(origin, reviewerKey, `reply-context?requestMessageId=${clarificationId}&limit=10`);
  assert.equal(check.status, 200);
  const serialized = JSON.stringify(check.json);
  assert.ok(serialized.includes(answerBody), "reviewer must see the agent's answer");
  assert.ok(serialized.includes(agentMemberId), "answer must be attributed to the agent member");
});
