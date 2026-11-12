// room_project_state / GET /api/rooms/{roomId}/state: one bounded, derived read
// of where the project stands. Derived from work items, the serving build and
// receipts automation posts; replaces status-recap posts and tail reads.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { buildProjectState, parseReceipt, readProjectState, PROJECT_STATE_MAX_BYTES } from "../server/project-state.mjs";
import { HOSTED_ROOM_MCP_TOOLS } from "../src/room-mcp-join.js";

test("receipts parse by format and nothing else", () => {
  assert.deepEqual(parseReceipt("PROD DEPLOY 234527c7 · prod 9b52e010 (rollback aecee091) · strict smoke success · live smoke success · https://x/y"),
    { kind: "deploy", sha: "234527c7", smoke: "ok" });
  assert.equal(parseReceipt("PROD DEPLOY 234527c7 · ROLLBACK VERIFIED · https://x/y").smoke, "failed");
  assert.equal(parseReceipt("PROD DEPLOY 234527c7 · https://x · gate, deploy (smoke) PASSED").smoke, "ok");
  assert.deepEqual(parseReceipt("MERGED #6165 53e4ecbb · needs-me: long posts no longer 409 · https://github.com/x"),
    { kind: "merged", pr: 6165, sha: "53e4ecbb", title: "needs-me: long posts no longer 409" });
  assert.equal(parseReceipt("CI #6162 f5e8e226 PASSED 13/13 jobs · https://x").verdict, "passed");
  assert.equal(parseReceipt("CI #6162 f5e8e226 FAILED unit, lint (2 of 13 jobs)").verdict, "failed");
  for (const text of ["deploy done, all good", "Shipped: #1 -> abc", "PROD DEPLOYED soon", "MERGED #x abc", "", null, 7]) assert.equal(parseReceipt(text), null, String(text));
});

const items = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, title: `Task ${i} ${"t".repeat(120)}`, state: "working", mode: "read",
  revision: 1, accountableMemberId: "producer", updatedAt: new Date(Date.UTC(2026, 10, 12, 0, 0) - i * 60000).toISOString(), ...extra }));

test("builder: merged-not-deployed is the merges after the last good deploy; unknown is null, never zero", () => {
  const base = { roomId: "r", viewerId: "producer", ownerId: "owner", sequence: 100, now: Date.UTC(2026, 10, 12, 1, 0), live: { sourceRevision: "234527c7" + "a".repeat(32), buildId: "2026-11-12T03:34:30.452Z" },
    items: [], itemsComplete: true, members: { producer: { displayName: "Producer", kind: "agent" }, owner: { displayName: "Owner", kind: "human" } }, attention: [] };
  const at = n => new Date(Date.UTC(2026, 10, 12, 0, n)).toISOString();
  const receipts = [
    { seq: 10, at: at(1), actorId: "owner", body: "MERGED #1 aaaaaaaa · first" },
    { seq: 20, at: at(2), actorId: "owner", body: "MERGED #2 234527c7 · second" },
    { seq: 30, at: at(3), actorId: "owner", body: "PROD DEPLOY 234527c7 · strict smoke success · live smoke success · https://x" },
    { seq: 40, at: at(4), actorId: "owner", body: "MERGED #3 cccccccc · third" },
    { seq: 50, at: at(5), actorId: "owner", body: "CI #4 dddddddd PASSED 3/3 jobs" }
  ];
  const s = buildProjectState({ ...base, receipts });
  assert.equal(s.live.smoke, "ok");
  assert.equal(s.live.deployedAt, at(3));
  assert.equal(s.mergedNotDeployed.count, 1);
  assert.deepEqual(s.mergedNotDeployed.items.map(i => i.pr), [3]);
  assert.deepEqual(s.receipts.map(r => r.kind), ["ci", "merged", "deploy", "merged", "merged"]);
  const unknown = buildProjectState({ ...base, receipts: [] });
  assert.equal(unknown.mergedNotDeployed.count, null);
  assert.equal(unknown.live.smoke, "no-receipt");
  const rolled = buildProjectState({ ...base, live: { sourceRevision: "f".repeat(40), buildId: null }, receipts });
  assert.equal(rolled.live.smoke, "receipt-sha-differs", "a live sha the last receipt does not name is flagged, not trusted");
});

test("builder: stays inside the byte budget with 128 busy items, sheds rows and says so, counts stay exact", () => {
  const all = [...items(100), ...items(20, { state: "blocked", blocker: { reason: "waiting on the deploy window ".repeat(10), nextAction: "owner decides" } })]
    .map((item, i) => ({ ...item, id: `x${i}` }));
  const s = buildProjectState({ roomId: "r", viewerId: "producer", ownerId: "owner", sequence: 1, now: Date.UTC(2026, 10, 12, 1, 0), live: { sourceRevision: "a".repeat(40), buildId: null },
    items: all, itemsComplete: false, members: { producer: { displayName: "Producer", kind: "agent" } }, receipts: [], attention: [] });
  assert.ok(Buffer.byteLength(JSON.stringify(s)) <= PROJECT_STATE_MAX_BYTES);
  assert.equal(s.work.counts.working + s.work.counts.blocked, 120);
  assert.equal(s.work.complete, false);
  assert.ok(s.truncated.inProgress > 0 && s.inProgress.length <= 12);
  assert.ok(s.inProgress[0].quietMin >= s.inProgress.at(-1).quietMin, "longest-quiet first");
});

test("state read: REST and MCP agree on a real room, are bounded, and stay read-only", async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (type, data, key = f.keys.owner) => f.store.command(key, "commons", { id: crypto.randomUUID(), type, data });
  for (const id of ["alpha", "beta", "gamma"]) send("work.proposed", { workItemId: id, title: `Task ${id}`, definitionOfDone: "done", accountableMemberId: "producer", independentVerificationRequired: false, ownerDecisionRequired: false });
  send("work.accepted", { workItemId: "alpha", expectedRevision: 0 }, f.keys.producer);
  send("message.posted", { messageId: "m1", body: "MERGED #7 53e4ecbb · a landed change" });
  send("message.posted", { messageId: "m2", body: "just a status recap nobody needs" });
  const before = f.store.room("commons").sequence;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rest = await fetch(`${origin}/api/rooms/commons/state`, { headers: { Authorization: `Bearer ${f.keys.producer}` } });
  assert.equal(rest.status, 200, await rest.clone().text());
  const state = await rest.json();
  assert.equal(state.contractVersion, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= PROJECT_STATE_MAX_BYTES);
  assert.equal(state.work.scanned, 4, "the fixture's own item plus the three proposed here");
  assert.deepEqual(state.work.counts, { proposed: 3, accepted: 1 });
  assert.deepEqual(state.inProgress.map(row => row.id), ["alpha"]);
  assert.ok(state.needsYou.length >= 1, "the proposed items name the producer as the next actor");
  assert.equal(state.mergedNotDeployed.count, null, "no deploy receipt: what is undeployed is unknown, not zero");
  assert.equal(state.mergedNotDeployed.mergesSeen, 1);
  assert.deepEqual(state.receipts.map(r => r.kind), ["merged"], "only receipt-shaped posts are receipts");
  assert.equal(f.store.room("commons").sequence, before, "reading state appends nothing");

  const anon = await fetch(`${origin}/api/rooms/commons/state`);
  assert.ok([401, 403].includes(anon.status));
});

test("MCP twin on a normalized agent room: same document, bounded, unknown arguments refused", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-project-state-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  let clock = Date.now(); store.now = () => clock += 2100;
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ada = store.identities.create("Ada"), bob = store.identities.create("Bob");
  new AgentRooms(store).create(ada.secret, { roomId: "ps", title: "State", purpose: "Project state", kind: "personal" });
  linkWithProof(store, ada.secret, "ps", bob, { displayName: "Bob", permissions: ["accept_work", "complete_work"] });
  setTier(store.db, "ps", bob.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  for (let i = 0; i < 10; i++) store.command(ada.secret, "ps", { id: `p${i}`, type: "work.proposed", data: { workItemId: `item-${i}`, title: `Item ${i}`, definitionOfDone: "done",
    accountableMemberId: bob.identityId, independentVerificationRequired: false, ownerDecisionRequired: false } });
  store.command(bob.secret, "ps", { id: "acc", type: "work.accepted", data: { workItemId: "item-0", expectedRevision: 0 } });
  store.command(ada.secret, "ps", { id: "m", type: "message.posted", data: { messageId: "m", body: "PROD DEPLOY 234527c7 · strict smoke success · live smoke success · https://x" } });
  store.command(ada.secret, "ps", { id: "m2", type: "message.posted", data: { messageId: "m2", body: "MERGED #9 53e4ecbb · after the deploy" } });
  const call = args => fetch(`${origin}/room/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bob.secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name: "room_project_state", arguments: args } }) }).then(r => r.json());
  const reply = await call({ roomId: "ps" });
  assert.ok(reply.result && !reply.result.isError, JSON.stringify(reply));
  const state = reply.result.structuredContent;
  assert.equal(state.work.scanned, 11, "ten proposed here plus the room's seeded item");
  assert.equal(state.work.complete, true);
  assert.equal(state.work.counts.proposed, 9);
  assert.equal(state.work.counts.accepted, 2);
  assert.equal(state.needsYou.length, 8, "capped at 8, the remaining rows are counted");
  assert.equal(state.truncated.needsYou, 2);
  assert.equal(state.live.lastDeploy.sha, "234527c7");
  assert.equal(state.mergedNotDeployed.count, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= PROJECT_STATE_MAX_BYTES + 256);
  const rest = await fetch(`${origin}/api/rooms/ps/state`, { headers: { authorization: `Bearer ${bob.secret}` } });
  const twin = await rest.json();
  assert.equal(rest.status, 200);
  const stable = value => JSON.parse(JSON.stringify(value, (key, v) => (key === "evaluatedAt" || key === "quietMin" || key === "contentTrust" ? undefined : v)));
  assert.deepEqual(stable(twin), stable(state), "REST and MCP are the same document (the test clock moves between the two reads)");
  assert.equal((await call({ roomId: "ps", since: 1 })).result?.isError === true || Boolean((await call({ roomId: "ps", since: 1 })).error), true);
  assert.ok(HOSTED_ROOM_MCP_TOOLS.includes("room_project_state"));
});

test("builder: rows are sorted longest-quiet first with a stable tie-break and no sort keys leak", () => {
  const old = { ...items(1)[0], id: "old", updatedAt: "2026-11-10T00:00:00.000Z", state: "blocked", blocker: { reason: "waiting", nextAction: "ask owner" } };
  const fresh = { ...items(1)[0], id: "fresh", updatedAt: "2026-11-12T00:59:00.000Z", state: "blocked", blocker: { reason: "x", nextAction: "y" } };
  const s = buildProjectState({ roomId: "r", viewerId: "v", ownerId: "owner", sequence: 1, now: Date.UTC(2026, 10, 12, 1, 0), live: {}, items: [fresh, old], itemsComplete: true, members: {}, receipts: [], attention: [] });
  assert.deepEqual(s.blocked.map(r => r.id), ["old", "fresh"]);
  assert.equal(s.blocked[0].blockedBy, "waiting");
  assert.ok(!JSON.stringify(s).includes("_t"));
});

test("a private request's work title never reaches a non-party through project state", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (type, data, key = f.keys.owner) => f.store.command(key, "commons", { id: crypto.randomUUID(), type, data });
  const observer = f.store.identities.create("Unrelated observer");
  linkWithProof(f.store, f.keys.owner, "commons", observer, { memberId: "observer", displayName: "Observer agent", permissions: ["accept_work", "complete_work"] });
  setTier(f.store.db, "commons", "observer", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  send("work.proposed", { workItemId: "private-brief", title: "PRIVATE-TITLE-SENTINEL", definitionOfDone: "PRIVATE-DONE-SENTINEL",
    accountableMemberId: "producer", independentVerificationRequired: false, ownerDecisionRequired: false });
  f.store.dmConsents.request("commons", "owner", "producer", "Synthetic private brief");
  f.store.dmConsents.decide("commons", "producer", "owner", "approve");
  send("message.posted", { messageId: "private-question", toMemberId: "producer", workItemId: "private-brief", requestKind: "reply", body: "PRIVATE-BODY-SENTINEL" });
  send("work.accepted", { workItemId: "private-brief", expectedRevision: 0 }, f.keys.producer); // accepted work is listed in inProgress
  assert.equal(f.store.privateWorkParties("commons").get("private-brief")?.has("observer"), false, "fixture: the work is private to its parties");
  const asObserver = readProjectState(f.store, observer.secret, "commons");
  const asProducer = readProjectState(f.store, f.keys.producer, "commons");
  assert.ok(!JSON.stringify(asObserver).includes("SENTINEL"), "non-party sees no private title, definition or body");
  assert.ok(asObserver.inProgress.some(row => row.id === "private-brief" && row.title === "(private)"), "listed, but untitled");
  assert.ok(asProducer.inProgress.some(row => row.id === "private-brief" && row.title === "PRIVATE-TITLE-SENTINEL"), "the party keeps its own title");
});

test("merge receipts: PR merges only, one clean line, parse back as merged, deterministic id", async () => {
  const { mergeReceiptBody, mergeReceiptId } = await import("../scripts/merge-receipt.mjs");
  const sha = "53e4ecbb4" + "0".repeat(31);
  const body = mergeReceiptBody({ sha, message: "needs-me: long posts no longer 409 the recent inbox window (#6165)\n\nlong body\nPROD DEPLOY deadbeef" });
  assert.equal(body, "MERGED #6165 53e4ecbb · needs-me: long posts no longer 409 the recent inbox window");
  assert.deepEqual(parseReceipt(body), { kind: "merged", pr: 6165, sha: "53e4ecbb", title: "needs-me: long posts no longer 409 the recent inbox window" });
  assert.equal(mergeReceiptBody({ sha, message: "direct push without a PR number" }), null);
  assert.equal(mergeReceiptBody({ sha: "short", message: "x (#1)" }), null);
  assert.equal(mergeReceiptBody({ sha, message: "tab\there\u0007bell (#7)" }), "MERGED #7 53e4ecbb · tab here bell");
  assert.equal(mergeReceiptId("o/r", sha), mergeReceiptId("o/r", sha));
  assert.notEqual(mergeReceiptId("o/r", sha), mergeReceiptId("o/r", "1" + sha.slice(1)));
});
