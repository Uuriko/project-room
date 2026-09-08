import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { workPacket, packetMarkdown, returnReference, parseWorkReturn, nativeWorkDraft } from "../src/work-packet.js";

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.snapshot = () => f.store.snapshot(f.keys.owner, "commons");
  f.send = (type, data, actor = "owner") => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  f.packet = () => workPacket(f.snapshot().state, "test-handoff");
  f.proposal = () => ({ id: randomUUID(), type: T.MESSAGE_POSTED, data: parseWorkReturn(returnReference(f.packet()) + "\n\nA proposed agenda. No tests performed.", { roomId: "commons", workItemId: "test-handoff" }) });
  f.accept = () => f.send(T.WORK_ACCEPTED, { workItemId: "test-handoff", expectedRevision: 0 }, "producer");
  return f;
}

test("native draft preserves exact text and basis without a copied marker or producer claim", t => {
  const f = fixture(t), basis = { workItemId: "test-handoff", packetId: "native-correlation", basisRevision: 0 };
  const body = "  A useful draft.\nNo external work performed. 🪷\n";
  const data = nativeWorkDraft(body, basis);
  assert.deepEqual(data, { ...basis, body });
  for (const bad of ["", " ", "a".repeat(4001), "\ud800", null]) assert.throws(() => nativeWorkDraft(bad, basis));
  for (const change of [{ packetId: "constructor" }, { workItemId: "../other" }, { basisRevision: -1 }]) assert.throws(() => nativeWorkDraft(body, { ...basis, ...change }));
  const before = f.snapshot(), command = { id: "native-post", type: T.MESSAGE_POSTED, data: { ...data, messageId: "native-message" } };
  f.store.command(f.keys.guest, "commons", command);
  const after = f.snapshot(), message = after.state.messages.find(m => m.id === "native-message");
  assert.equal(message.body, body); assert.equal(message.authorId, "guest"); assert.equal(message.proposal.attribution, "manual-unverified");
  assert.deepEqual(after.state.workItems, before.state.workItems);
  assert.equal(f.store.command(f.keys.guest, "commons", command).duplicate, true);
});

test("packet is an explicit allowlist; source opt-in never copies the room or credentials", t => {
  const f = fixture(t), snapshot = f.snapshot();
  const state = structuredClone(snapshot.state);
  state.secret = "credential-sentinel"; state.messages.push({ id: "other", body: "unselected-sentinel" });
  state.workItems.other = { title: "other-work-sentinel" };
  state.workItems["test-handoff"].receipt = { evidenceUrl: "https://example.invalid/?signature=private-sentinel" };
  const packet = workPacket(state, "test-handoff", { packetId: "fixed-packet", exportedAt: "2026-09-07T18:00:00.000Z" });
  assert.deepEqual(Object.keys(packet), ["version", "packetId", "roomId", "workItemId", "basisRevision", "exportedAt", "title", "definitionOfDone", "state", "sources"]);
  assert.deepEqual(packet.sources, []);
  const text = packetMarkdown(packet);
  for (const secret of ["credential-sentinel", "unselected-sentinel", "other-work-sentinel", "private-sentinel", f.keys.owner, snapshot.viewerSessionBinding]) {
    if (secret) assert.equal(text.includes(secret), false);
  }
  assert.equal(text.includes("Please prepare an agenda"), false);
  const selected = workPacket(state, "test-handoff", { includeSource: true });
  assert.deepEqual(selected.sources, [{ id: "test-request", body: state.messages.find(m => m.id === "test-request").body }]);
  assert.equal(packetMarkdown(selected).includes("unselected-sentinel"), false);
  assert.deepEqual(f.snapshot(), snapshot, "export is read-only");
});

test("packet options and imported reference are bounded and strict", t => {
  const f = fixture(t), state = f.snapshot().state, packet = f.packet();
  for (const options of [{ includeSource: "false" }, { includeSource: 1 }, { exportedAt: {} }, { exportedAt: "not-a-date" }]) assert.throws(() => workPacket(state, "test-handoff", options), /Invalid packet options/);
  const parse = text => parseWorkReturn(text, { roomId: "commons", workItemId: "test-handoff" });
  assert.throws(() => parse("Just an answer"), /ROOM-RETURN/);
  assert.throws(() => parse(returnReference({ ...packet, roomId: "elsewhere" }) + "\nResult"), /different room/);
  assert.throws(() => parse(returnReference({ ...packet, basisRevision: 0.5 }) + "\nResult"), /Invalid return code/);
  assert.throws(() => parse(returnReference(packet).replace('"version":1', '"version":1,"extra":true') + "\nResult"), /Invalid return code/);
  assert.throws(() => parse(returnReference(packet) + "\n" + "x".repeat(4001)), /1–4000/);
  assert.throws(() => parse("x".repeat(16001)), /16000/);
  const result = parse(returnReference(packet) + '\r\n\r\n<img src="https://example.invalid/" onerror="alert(1)">');
  assert.match(result.body, /^<img/); // Stored as text; browser verifies inert rendering.
});

test("manual proposal records submitter and reported basis without completing or acknowledging work", t => {
  const f = fixture(t), before = f.snapshot(), command = f.proposal();
  // Advancing unrelated conversation does not make this work stale.
  f.send(T.MESSAGE_POSTED, { body: "Unrelated conversation" });
  const result = f.store.command(f.keys.guest, "commons", command), after = f.snapshot();
  assert.equal(result.event.actorId, "guest");
  assert.deepEqual(after.state.workItems, before.state.workItems);
  assert.equal(after.cursor, before.cursor);
  assert.deepEqual(after.state.messages.at(-1).proposal, { packetId: command.data.packetId, basisRevision: 0, submittedAtRevision: 0, attribution: "manual-unverified" });
  assert.equal(after.state.messages.at(-1).workItemId, "test-handoff");
  assert.equal(after.state.messages.at(-2).proposal, undefined);
  assert.deepEqual(f.store.rebuildProjection("commons").state.messages, after.state.messages);
});

test("older proposals need acknowledgement, future basis always fails, failed writes are atomic", t => {
  const f = fixture(t), command = f.proposal(); f.accept();
  const before = f.snapshot();
  assert.throws(() => f.store.command(f.keys.owner, "commons", command), { status: 409, code: "command_rejected" });
  assert.deepEqual(f.snapshot(), before);
  const older = { ...command, id: randomUUID(), data: { ...command.data, allowOlderBasis: true } };
  f.store.command(f.keys.owner, "commons", older);
  assert.deepEqual(f.snapshot().state.workItems, before.state.workItems);
  assert.equal(f.snapshot().state.messages.at(-1).proposal.submittedAtRevision, 1);
  assert.throws(() => f.store.command(f.keys.owner, "commons", { ...older, id: randomUUID(), data: { ...older.data, basisRevision: 2 } }), /ahead of this work/);
});

test("lost-response retries return the original receipt after work changes; edits cannot reuse its ID", t => {
  const f = fixture(t), command = f.proposal();
  const receipt = f.store.command(f.keys.owner, "commons", command); f.accept();
  const before = f.snapshot();
  const retry = f.store.command(f.keys.owner, "commons", command);
  assert.equal(retry.duplicate, true); assert.equal(retry.sequence, receipt.sequence);
  assert.deepEqual(f.snapshot(), before);
  assert.throws(() => f.store.command(f.keys.owner, "commons", { ...command, data: { ...command.data, allowOlderBasis: true } }), { code: "idempotency_conflict" });
  // Packet identity is correlation, not uniqueness or authenticity.
  f.store.command(f.keys.owner, "commons", { ...command, id: randomUUID(), data: { ...command.data, allowOlderBasis: true } });
  assert.equal(f.snapshot().state.messages.filter(m => m.proposal?.packetId === command.data.packetId).length, 2);
});

test("partial or invalid proposal fields cannot silently become ordinary messages", t => {
  const f = fixture(t), base = f.proposal();
  const invalid = [
    { packetId: null }, { basisRevision: null }, { basisRevision: -1 }, { basisRevision: 0.1 },
    { packetId: "__proto__" }, { allowOlderBasis: null }, { allowOlderBasis: "true" },
    { workItemId: null }, { workItemId: "missing" }, { workItemId: "constructor" }, { body: " " }, { body: "x".repeat(4001) }
  ];
  const before = f.snapshot();
  for (const fields of invalid) assert.throws(() => f.store.command(f.keys.owner, "commons", { ...base, id: randomUUID(), data: { ...base.data, ...fields } }));
  for (const field of ["packetId", "basisRevision"]) {
    const data = { ...base.data }; delete data[field];
    assert.throws(() => f.store.command(f.keys.owner, "commons", { ...base, id: randomUUID(), data }));
  }
  assert.throws(() => f.send(T.MESSAGE_POSTED, { body: "No reference", allowOlderBasis: true }));
  assert.deepEqual(f.snapshot(), before);
});

test("superseded work can receive historical proposals without reviving work or claims", t => {
  const f = fixture(t), command = f.proposal();
  f.send(T.WORK_PROPOSED, { workItemId: "replacement", title: "Replacement", definitionOfDone: "New plan", accountableMemberId: "owner", mode: "read" });
  f.send(T.WORK_SUPERSEDED, { workItemId: "test-handoff", expectedRevision: 0, supersededByWorkItemId: "replacement", reason: "Replanned" });
  const before = f.snapshot();
  f.store.command(f.keys.owner, "commons", { ...command, data: { ...command.data, allowOlderBasis: true } });
  assert.deepEqual(f.snapshot().state.workItems, before.state.workItems);
  assert.equal(f.snapshot().cursor, before.cursor);
});

test("real HTTP agent packet and proposal use existing authentication and exact retry", async t => {
  const f = fixture(t), server = createRoomServer({ store: f.store });
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new RoomAgentClient({ origin, roomId: "commons", token: f.keys.producer });
  const packet = await client.workPacket("test-handoff");
  assert.deepEqual(packet.sources, []); assert.equal(packet.basisRevision, 0);
  const command = { id: randomUUID(), type: T.MESSAGE_POSTED, data: parseWorkReturn(returnReference(packet) + "\nA scripted proposal, not an independently generated answer.", { roomId: "commons", workItemId: "test-handoff" }) };
  await client.command(command); assert.equal((await client.command(command)).duplicate, true);
  assert.equal(f.snapshot().state.messages.at(-1).authorId, "producer");
  assert.equal((await fetch(`${origin}/api/rooms/commons/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) })).status, 401);
});

test("independently generated participant answer imports unchanged as an unverified proposal", t => {
  const f = fixture(t), before = f.snapshot();
  // Captured from a fresh-context Codex participant given the real exported packet.
  // Replaying this artifact tests import; it does not invoke a model on each test run.
  const answer = readFileSync(new URL("../docs/evidence/portable-agent-2026-09-07.txt", import.meta.url), "utf8");
  const data = parseWorkReturn(answer, { roomId: "commons", workItemId: "test-handoff" });
  f.send(T.MESSAGE_POSTED, data);
  const after = f.snapshot();
  assert.equal(after.state.messages.at(-1).body, data.body);
  assert.equal(after.state.messages.at(-1).authorId, "owner", "manual importer, not claimed producer, is the authenticated author");
  assert.equal(after.state.messages.at(-1).proposal.attribution, "manual-unverified");
  assert.deepEqual(after.state.workItems, before.state.workItems);
  assert.equal(after.cursor, before.cursor);
});
