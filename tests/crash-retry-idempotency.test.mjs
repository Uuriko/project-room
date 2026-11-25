// Durable-harness item #2 qualification (Commons 7300/7301): a formal request
// and its answer are committed, the response is dropped before the caller sees
// it, and the caller retries with the same seat and operation id. Counts the
// durable request records, receiver handoffs (each one a provider dispatch by
// the Muse host) and accepted answers on a real server and store.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { holdMuseHandoff, museHandoffPolicy } from "../scripts/muse-stream-handoff.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

async function room(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const codex = store.identities.create("Codex"), muse = store.identities.create("Muse");
  for (const [identity, memberId, displayName] of [[codex, "codex", "Codex"], [muse, "muse", "Muse"]])
    linkWithProof(store, ownerKey, "commons", identity, { memberId, displayName, permissions: ["accept_work", "complete_work"] });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Drop the response to the next matching POST after the server has committed it.
  const dropper = () => {
    let armed = null;
    const fetchImpl = async (url, options = {}) => {
      const response = await fetch(url, options);
      if (armed && options.method === "POST" && armed(JSON.parse(options.body ?? "null"))) {
        if (!response.ok) throw new Error(`refused before commit: ${response.status} ${await response.text()}`);
        armed = null;
        await response.arrayBuffer();
        throw new TypeError("synthetic connection closed after commit");
      }
      return response;
    };
    return { fetchImpl, dropNext(match) { armed = match; } };
  };
  const client = (identity, memberId) => {
    const net = dropper();
    return { net, client: new RoomAgentClient({ origin, roomId: "commons", token: identity.secret, memberId, fetchImpl: net.fetchImpl }) };
  };
  return { store, codex: client(codex, "codex"), muse: client(muse, "muse") };
}

const count = (store, sql, ...args) => store.db.prepare(sql).get(...args).n;
const requestsOpened = store => count(store, "SELECT count(*) n FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.requestKind')='reply'");
const answers = (store, id) => count(store, "SELECT count(*) n FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.responseToRequestId')=?", id);
const acks = store => count(store, "SELECT count(*) n FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='reply_request.progressed' AND json_extract(body,'$.data.progress')='acknowledged'");

async function scenario(t, { acceptBeforeDispatch }) {
  const f = await room(t);
  const ask = { id: "op-ask-1", type: "message.posted", data: { messageId: "ask-1", body: "Please check this.", toMemberId: "muse", requestKind: "reply" } };

  // 1. Requester: the request commits, the response is lost, the same seat retries the same operation id.
  f.codex.net.dropNext(body => body?.id === ask.id);
  await assert.rejects(f.codex.client.command(ask), /connection closed after commit/);
  assert.equal(requestsOpened(f.store), 1, "the request is durable before the caller saw a response");
  const retried = await f.codex.client.command(ask);
  assert.equal(retried.duplicate, true, "the retry returns the original result");
  assert.equal(requestsOpened(f.store), 1, "exactly one durable request");
  const requestId = (await f.codex.client.replyRequests({ direction: "outgoing", status: "open" })).requests[0].id;

  // 2. Receiver (Muse host): the ack commits, the response is lost, the helper restarts from its checkpoint.
  const policy = museHandoffPolicy({ version: 1, origin: f.muse.client.origin ?? undefined, roomId: "commons", memberId: "muse",
    requesters: ["codex"], workItems: [], requests: [], allowStandaloneRequests: true, bootstrapAfter: 0, windowSeconds: 10 },
  { origin: f.muse.client.origin ?? undefined, roomId: "commons", memberId: "muse" });
  let checkpoint = { after: 0, inFlight: null };
  let dispatches = 0;
  const host = async () => {
    const result = await holdMuseHandoff({ client: f.muse.client, policy, checkpoint, receiverAck: true, wait: false,
      signal: new AbortController().signal, save(state) { checkpoint = state; } });
    if (result.status === "handoff") {
      if (acceptBeforeDispatch) {
        const current = (await f.muse.client.replyContext(result.requestMessageId, { view: "compact" })).request;
        await f.muse.client.command({ id: `accept-${result.openingEventId}`, type: "reply_request.progressed",
          data: { requestMessageId: result.requestMessageId, expectedRequestRevision: current.revision, progress: "accepted" } });
      }
      dispatches += 1; // the host starts one provider turn per handoff
    }
    return result;
  };
  f.muse.net.dropNext(body => body?.type === "reply_request.progressed");
  await assert.rejects(host(), /connection closed after commit/);
  assert.equal(acks(f.store), 1);
  assert.equal(dispatches, 0, "no provider turn before the ack is confirmed");
  const offered = await host();
  assert.equal(offered.receiverAcknowledgment?.duplicate, true, "the restart replays the recorded ack");
  assert.equal(acks(f.store), 1, "exactly one receiver ack");

  // 3. The host crashes after starting the provider turn and before any later write; it restarts.
  const restarted = await host();
  if (acceptBeforeDispatch) {
    assert.equal(restarted.status, "no_work", "an accepted request is not re-offered");
  } else {

  assert.equal(restarted.status, "handoff");
  assert.equal(restarted.replay, true, "the restart re-offers the acknowledged request");
  }

  // 4. The answer commits, the response is lost, the same seat retries the same operation id.
  const context = await f.muse.client.replyContext(requestId, { view: "compact" });
  const revision = context.request.revision;
  const recipe = context.responseHttpActions.find(action => action.command.data.responseOutcome === "answered").command;
  const answer = { ...recipe, id: "op-answer-1", data: { ...recipe.data, body: "Checked." } };
  f.muse.net.dropNext(body => body?.id === answer.id);
  await assert.rejects(f.muse.client.command(answer), /connection closed after commit/);
  assert.equal(answers(f.store, requestId), 1, "the answer is durable before the caller saw a response");
  const again = await f.muse.client.command(answer);
  assert.equal(again.duplicate, true, "the retry returns the original answer");
  assert.equal(answers(f.store, requestId), 1, "exactly one accepted answer");
  const closed = await f.codex.client.replyContext(requestId, { view: "compact" });
  assert.equal(closed.request.status, "answered");
  assert.equal(closed.request.revision, revision + 1);

  // 5. Once answered, a host restart offers nothing.
  assert.equal((await host()).status, "no_work");
  return { requestsOpened: requestsOpened(f.store), acks: acks(f.store), answers: answers(f.store, requestId), dispatches };
}


test("crash/retry: the request, the receiver ack and the answer are each recorded once and retries return the original", async t => {
  const counts = await scenario(t, { acceptBeforeDispatch: false });
  t.diagnostic(JSON.stringify(counts));
  assert.equal(counts.requestsOpened, 1);
  assert.equal(counts.acks, 1);
  assert.equal(counts.answers, 1);
});

// Gap (durable-harness #2/#3): a Muse host that crashes after starting its
// provider turn and before any later Room write is re-offered the same request
// on restart (scripts/muse-stream-handoff.mjs holdMuseHandoff inFlight replay,
// pointer() treats our own "acknowledged" receipt as replayable). Nothing in
// the Room records that the provider turn started, so the restart cannot tell
// "never dispatched" from "dispatched, outcome unknown".
test("crash/retry: one provider dispatch per request when the host crashes after dispatch", { todo: "needs a durable host acceptance before dispatch (design call: Codex, scripts/muse-stream-handoff.mjs)" }, async t => {
  const counts = await scenario(t, { acceptBeforeDispatch: false });
  assert.equal(counts.dispatches, 1);
});

// Store-before-dispatch: a host that commits progress "accepted" before it
// starts the provider should not be re-offered after a crash. Today the server
// records it (the selected request gains acceptedAt, src/reply-requests.js:255),
// but RoomAgentClient refuses that read: client/reply-actions.mjs
// selectedRequestKeys() allows only acknowledgedAt, lastActivityAt,
// progressState, progressNote and progressEventId, so the restart throws
// "Request response does not match the selected room, identity or window".
test("crash/retry: a host that records acceptance before dispatch is not re-offered after a crash", { todo: "client/reply-actions.mjs must accept acceptedAt/workingAt on a selected request (overlaps #6486, #6321)" }, async t => {
  const counts = await scenario(t, { acceptBeforeDispatch: true });
  assert.equal(counts.dispatches, 1);
  assert.equal(counts.answers, 1);
});
