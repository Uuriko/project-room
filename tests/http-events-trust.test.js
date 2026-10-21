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
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const agentKey = store.issueAccessKey("commons", "agent");
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
  const canonical = redactEventPage(store.eventsAfter(ownerKey, "commons", 0, 100), store.redactionMessages("commons"));
  const canonicalBySequence = new Map(canonical.events.map(entry => [entry.sequence, entry]));
  return { store, get, origin, agentKey, canonicalBySequence };
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
  assert.ok(!("untrusted" in own), "the viewer's own message wrapper stays unmarked");
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
  assert.ok(own && !("untrusted" in own), "the viewer's own message frame wrapper stays unmarked");
  const editedOwn = frames.find(frame => frame.event?.type === "message.edited" && frame.event?.data?.messageId === "own-msg");
  assert.equal(editedOwn.untrusted, true, "the owner's rewrite frame is marked by the editor");
  const proposed = frames.find(frame => frame.event?.type === "work.proposed");
  assert.equal(proposed.untrusted, true, "another member's work.proposed frame wrapper is marked untrusted");
  assertEnvelopesByteIdentical(frames, canonicalBySequence);
});
