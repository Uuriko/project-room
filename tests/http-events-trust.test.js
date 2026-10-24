// F9 SEC-2b: the raw HTTP /events page and the SSE /stream frames carry the
// content-trust stamp at the boundary, like the MCP door always did. The
// stamp lives on the page and on the {sequence, event} wrapper only — the
// signed event envelope inside is byte-identical to the canonical event the
// read path serves (sha256-checked below), never re-serialized with extra
// fields. Canonical here means the store page after the pre-existing
// PRIV-1 read fold (redactEventPage: an edited message's envelopes carry
// its current body), which is the exact input stampEvents receives.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { CONTENT_TRUST } from "../server/content-trust.mjs";
import { redactEventPage } from "../server/redact-read.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";

const sha256 = text => createHash("sha256").update(text).digest("hex");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-http-events-trust-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: {
    memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work"] } });
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: {
    memberId: "peer", displayName: "Test peer", kind: "agent", permissions: ["accept_work"] } });
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  setTier(store.db, "commons", "peer", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const agentKey = store.issueAccessKey("commons", "agent");
  const peerKey = store.issueAccessKey("commons", "peer");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, token = agentKey) => fetch(origin + path, {
    headers: { Origin: origin, Authorization: `Bearer ${token}` }
  });
  const postAs = (key, body) => store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: body });
  postAs(ownerKey, { messageId: "other-msg", body: "posted by the owner" });
  postAs(agentKey, { messageId: "own-msg", body: "posted by the viewer" });
  // CURE-4437-TRUST specimen: the classes #4437 missed. The owner rewrites
  // the viewer's own message (the wrapper's text is now the EDITOR's, so the
  // edit event must be marked for the viewer even though the original post
  // was the viewer's own), the owner edits their own message, and the owner
  // proposes work whose title/definitionOfDone are member text.
  const commandAs = (key, type, data) => store.command(key, "commons", { id: randomUUID(), type, data });
  commandAs(ownerKey, T.MESSAGE_EDITED, { messageId: "own-msg", body: "rewritten by the owner", expectedMessageRevision: 0 });
  commandAs(ownerKey, T.MESSAGE_EDITED, { messageId: "other-msg", body: "the owner's edited text", expectedMessageRevision: 0 });
  commandAs(ownerKey, T.WORK_PROPOSED, { workItemId: "work-1", title: "Owner's proposed task", definitionOfDone: "the thing is done", accountableMemberId: "agent" });
  // CURE-4437-2 specimen: a peer post the peer then edits themselves. The
  // folded post envelope serves the peer's edited text, authored by the peer
  // throughout — the control case for editor keying (no foreign editor).
  postAs(peerKey, { messageId: "peer-msg", body: "posted by the peer" });
  commandAs(peerKey, T.MESSAGE_EDITED, { messageId: "peer-msg", body: "the peer's edited text", expectedMessageRevision: 0 });
  const canonical = redactEventPage(store.eventsAfter(ownerKey, "commons", 0, 100), store.redactionMessages("commons"));
  const canonicalBySequence = new Map(canonical.events.map(entry => [entry.sequence, entry]));
  return { store, get, origin, agentKey, ownerKey, peerKey, commandAs, canonicalBySequence };
}

function assertEnvelopesByteIdentical(entries, canonicalBySequence) {
  for (const entry of entries) {
    const canonical = canonicalBySequence.get(entry.sequence);
    assert.ok(canonical, `sequence ${entry.sequence} exists in the canonical page`);
    assert.equal(JSON.stringify(entry.event), JSON.stringify(canonical.event),
      `envelope at sequence ${entry.sequence} is byte-identical to the canonical event`);
    assert.equal(sha256(JSON.stringify(entry.event)), sha256(JSON.stringify(canonical.event)),
      `envelope sha256 at sequence ${entry.sequence} matches the canonical event`);
  }
}

test("http /events page is trust-stamped; envelopes stay byte-identical", async t => {
  const { get, canonicalBySequence } = await serve(t);
  const page = await (await get("/api/rooms/commons/events?after=0&limit=100")).json();
  assert.equal(page.contentTrust, CONTENT_TRUST, "the page carries the contentTrust marker");
  const other = page.events.find(({ event }) => event.data?.messageId === "other-msg");
  const own = page.events.find(({ event }) => event.data?.messageId === "own-msg");
  assert.equal(other.untrusted, true, "another member's message wrapper is marked untrusted");
  // CURE-4437-2: the folded post envelope serves the CURRENT body — for
  // own-msg that is the owner's rewrite, not the viewer's text — so the post
  // wrapper is keyed on the last editor and marked for the viewer. (Before
  // the cure this asserted the wrapper stays unmarked: that was the
  // residual REV-4437-2 graded HOLD.)
  assert.equal(own.event.data.body, "rewritten by the owner", "the folded post envelope serves the editor's current text");
  assert.equal(own.untrusted, true, "a post whose served text is the owner's rewrite is marked by the editor, not keyed on the poster");
  const memberAdded = page.events.find(({ event }) => event.type === "member.added");
  assert.ok(!("untrusted" in memberAdded), "label-only wrappers (member.added displayName) are not marked");
  const roomCreated = page.events.find(({ event }) => event.type === "room.created");
  assert.ok(roomCreated && !("untrusted" in roomCreated), "the owner-authored room.created wrapper is not marked");
  const editedOwn = page.events.find(({ event }) => event.type === "message.edited" && event.data?.messageId === "own-msg");
  assert.equal(editedOwn.untrusted, true, "the owner's rewrite of the viewer's own message is marked by the editor");
  const editedOther = page.events.find(({ event }) => event.type === "message.edited" && event.data?.messageId === "other-msg");
  assert.equal(editedOther.untrusted, true, "another member's edit wrapper is marked untrusted");
  const proposed = page.events.find(({ event }) => event.type === "work.proposed");
  assert.equal(proposed.untrusted, true, "another member's work.proposed wrapper is marked untrusted");
  assertEnvelopesByteIdentical(page.events, canonicalBySequence);
});

test("http /events tail branch is trust-stamped too", async t => {
  const { get, canonicalBySequence } = await serve(t);
  const page = await (await get("/api/rooms/commons/events?tail=10")).json();
  assert.equal(page.contentTrust, CONTENT_TRUST, "the tail page carries the contentTrust marker");
  const other = page.events.find(({ event }) => event.data?.messageId === "other-msg");
  assert.equal(other.untrusted, true, "another member's message wrapper is marked untrusted on the tail");
  const proposed = page.events.find(({ event }) => event.type === "work.proposed");
  assert.equal(proposed.untrusted, true, "another member's work.proposed wrapper is marked untrusted on the tail");
  assertEnvelopesByteIdentical(page.events, canonicalBySequence);
});

async function readFramesUntil(response, predicate, timeoutMs = 8000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise(resolve => setTimeout(() => resolve({ done: true }), Math.max(1, deadline - Date.now())))
      ]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const dataLine = raw.split("\n").find(line => line.startsWith("data: "));
        if (dataLine) frames.push(JSON.parse(dataLine.slice(6)));
        if (predicate(frames)) return frames;
      }
      if (predicate(frames)) return frames;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return frames;
}

test("sse /stream frames are trust-stamped; envelopes stay byte-identical", async t => {
  const { origin, agentKey, canonicalBySequence } = await serve(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${origin}/api/rooms/commons/stream?after=0`, {
    headers: { Authorization: `Bearer ${agentKey}`, Accept: "text/event-stream" },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  const frames = await readFramesUntil(response, list =>
    list.some(frame => frame.event?.data?.messageId === "other-msg")
    && list.some(frame => frame.event?.data?.messageId === "own-msg")
    && list.some(frame => frame.event?.type === "message.edited")
    && list.some(frame => frame.event?.type === "work.proposed"));
  controller.abort();
  const other = frames.find(frame => frame.event?.data?.messageId === "other-msg");
  const own = frames.find(frame => frame.event?.data?.messageId === "own-msg");
  assert.ok(other, "the owner's message arrived as a stream frame");
  assert.equal(other.untrusted, true, "another member's message frame wrapper is marked untrusted");
  // CURE-4437-2: as on the page, the own-msg post frame serves the owner's
  // rewritten text, so its wrapper is marked by the editor for the viewer.
  assert.ok(own, "the viewer's message arrived as a stream frame");
  assert.equal(own.untrusted, true, "a post frame whose served text is the owner's rewrite is marked by the editor");
  const editedOwn = frames.find(frame => frame.event?.type === "message.edited" && frame.event?.data?.messageId === "own-msg");
  assert.equal(editedOwn.untrusted, true, "the owner's rewrite frame is marked by the editor");
  const proposed = frames.find(frame => frame.event?.type === "work.proposed");
  assert.equal(proposed.untrusted, true, "another member's work.proposed frame wrapper is marked untrusted");
  assertEnvelopesByteIdentical(frames, canonicalBySequence);
});

// CURE-4437-2: the filtered read is the documented polling pattern (the MCP
// room_list_events description itself uses type=message.posted as its
// example filter). A consumer who filters to posts never sees the
// message.edited wrapper, so the post wrapper alone must carry the true
// author of the text it serves: the last editor, not the original poster.
test("filtered /events?type=message.posted keys post wrappers on the last editor", async t => {
  const { get, ownerKey, peerKey, canonicalBySequence } = await serve(t);
  const posted = (page, id) => page.events.find(({ event }) => event.type === "message.posted" && event.data?.messageId === id);

  const asAgent = await (await get("/api/rooms/commons/events?type=message.posted&limit=100")).json();
  const ownPost = posted(asAgent, "own-msg");
  assert.equal(ownPost.event.data.body, "rewritten by the owner", "the filtered post serves the editor's current text");
  assert.equal(ownPost.untrusted, true, "owner-rewritten own post is marked on a filtered read, never bare");
  const peerPost = posted(asAgent, "peer-msg");
  assert.equal(peerPost.event.data.body, "the peer's edited text", "the filtered post serves the peer's edited text");
  assert.equal(peerPost.untrusted, true, "a peer's self-edited post is marked for another viewer");
  assertEnvelopesByteIdentical(asAgent.events, canonicalBySequence);

  const compact = await (await get("/api/rooms/commons/events?type=message.posted&compact=1&limit=100")).json();
  assert.equal(posted(compact, "own-msg").untrusted, true, "the compact filtered read marks the owner-rewritten post too");

  const asOwner = await (await get("/api/rooms/commons/events?type=message.posted&limit=100", ownerKey)).json();
  assert.ok(!("untrusted" in posted(asOwner, "own-msg")), "the owner reading their own rewrite text stays unmarked");
  assert.equal(posted(asOwner, "peer-msg").untrusted, true, "the peer's edited post is marked for the owner");

  const asPeer = await (await get("/api/rooms/commons/events?type=message.posted&limit=100", peerKey)).json();
  assert.ok(!("untrusted" in posted(asPeer, "peer-msg")), "the peer reading their own self-edited post stays unmarked");
  assert.equal(posted(asPeer, "own-msg").untrusted, true, "the owner-rewritten post is marked for the peer");
});

// CURE-4437-2 (audit of the NO-TEXT class): room.archived carries an
// optional member-authored reason (≤280 chars), stored on the room as
// archiveReason — the same shape as owner.decision_recorded's reason,
// which the stamp class already covers.
test("room.archived with a member reason is trust-stamped", async t => {
  const { store, get, commandAs, ownerKey } = await serve(t);
  commandAs(ownerKey, T.ROOM_ARCHIVED, { reason: "winding down: trust specimen" });
  const page = await (await get("/api/rooms/commons/events?after=0&limit=100")).json();
  const archived = page.events.find(({ event }) => event.type === "room.archived");
  assert.ok(archived, "the archive event is served on the page");
  assert.equal(archived.event.data.reason, "winding down: trust specimen");
  assert.equal(archived.untrusted, true, "the archive reason is member text: marked for a non-owner viewer");
  const canonical = redactEventPage(store.eventsAfter(ownerKey, "commons", 0, 100), store.redactionMessages("commons"));
  assertEnvelopesByteIdentical(page.events, new Map(canonical.events.map(entry => [entry.sequence, entry])));
});

// CURE-4437-2 (audit): ownership.transferred validates an optional
// member-authored reason (≤280 chars) that rides in the event data.
test("ownership.transferred with a member reason is trust-stamped", async t => {
  const { store, get, commandAs, ownerKey, peerKey } = await serve(t);
  commandAs(ownerKey, T.OWNERSHIP_TRANSFERRED, { toMemberId: "agent", reason: "handing the room over" });
  const page = await (await get("/api/rooms/commons/events?after=0&limit=100", peerKey)).json();
  const transferred = page.events.find(({ event }) => event.type === "ownership.transferred");
  assert.ok(transferred, "the transfer event is served on the page");
  assert.equal(transferred.event.data.reason, "handing the room over");
  assert.equal(transferred.untrusted, true, "the transfer reason is member text: marked for a third-party viewer");
  const canonical = redactEventPage(store.eventsAfter(ownerKey, "commons", 0, 100), store.redactionMessages("commons"));
  assertEnvelopesByteIdentical(page.events, new Map(canonical.events.map(entry => [entry.sequence, entry])));
});

// CURE-4437-2 (audit): reply_request.cancelled REQUIRES a member-authored
// reason (cancelReplyRequest: "Cancellation needs a reason", free text
// ≤4096 chars) — it is not a bare request-id reference.
test("reply_request.cancelled with its required reason is trust-stamped", async t => {
  const { store, get, commandAs, agentKey, ownerKey } = await serve(t);
  // The store injects requestPolicyVersion itself when it builds the event;
  // the command carries only the request fields.
  commandAs(agentKey, T.MESSAGE_POSTED, {
    messageId: "req-1", body: "please review my work", toMemberId: "owner",
    requestKind: "reply"
  });
  commandAs(agentKey, T.REPLY_REQUEST_CANCELLED, {
    requestMessageId: "req-1", expectedRequestRevision: 0, reason: "no longer needed"
  });
  const page = await (await get("/api/rooms/commons/events?after=0&limit=100", ownerKey)).json();
  const cancelled = page.events.find(({ event }) => event.type === "reply_request.cancelled");
  assert.ok(cancelled, "the cancellation event is served on the page");
  assert.equal(cancelled.event.data.reason, "no longer needed");
  assert.equal(cancelled.untrusted, true, "the cancellation reason is member text: marked for the recipient");
  const canonical = redactEventPage(store.eventsAfter(ownerKey, "commons", 0, 100), store.redactionMessages("commons"));
  assertEnvelopesByteIdentical(page.events, new Map(canonical.events.map(entry => [entry.sequence, entry])));
});

// CURE-4437-2 (audit): session.started records a member-written environment
// string (validateAttemptEnvironment: any string of 1-200 chars, not
// slug-normalized) — arbitrary prose in the envelope, the
// member.status_updated shape.
test("session.started with a member-written environment is trust-stamped", async t => {
  const { store, get, commandAs, agentKey, ownerKey } = await serve(t);
  commandAs(agentKey, T.SESSION_STARTED, { workItemId: "work-1", environment: "sandbox-7, member written" });
  const page = await (await get("/api/rooms/commons/events?after=0&limit=100", ownerKey)).json();
  const started = page.events.find(({ event }) => event.type === "session.started");
  assert.ok(started, "the session event is served on the page");
  assert.equal(started.event.data.environment, "sandbox-7, member written");
  assert.equal(started.untrusted, true, "the session environment is member text: marked for the owner");
  const canonical = redactEventPage(store.eventsAfter(ownerKey, "commons", 0, 100), store.redactionMessages("commons"));
  assertEnvelopesByteIdentical(page.events, new Map(canonical.events.map(entry => [entry.sequence, entry])));
});

// CURE-4437-2 item 3: stampThread (the projection door behind
// room_read_messages) keyed on the message's authorId while serving the
// current — possibly editor-written — body. It now keys on the text
// author (messageTextAuthorId), like the event doors.
test("thread door keys the stamp on the last editor of the served text", async t => {
  const { store, agentKey, ownerKey } = await serve(t);
  const asAgent = store.messageThread(agentKey, "commons", "own-msg");
  assert.equal(asAgent.thread.body, "rewritten by the owner", "the thread serves the editor's current text");
  assert.equal(asAgent.thread.untrusted, true, "owner-rewritten text is marked for the original poster");
  const asOwner = store.messageThread(ownerKey, "commons", "own-msg");
  assert.ok(!("untrusted" in asOwner.thread), "the owner reading their own rewrite stays unmarked");
  const peerThread = store.messageThread(agentKey, "commons", "peer-msg");
  assert.equal(peerThread.thread.body, "the peer's edited text");
  assert.equal(peerThread.thread.untrusted, true, "the peer's self-edited text is marked for another viewer");
});
