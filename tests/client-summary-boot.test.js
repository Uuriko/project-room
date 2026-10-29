// Summary-first boot: a client created with summaryBoot renders its
// first paint from the boot summary (summaryVersion 1, see
// src/boot-summary.js) instead of the windowed snapshot's whole state,
// and loads detail per view — the board's work items through the scoped
// ?view=work read — only when a view asks for it.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomClient } from "../src/client.js";
import { deriveBootSummary, isBootSummary, mergeWorkDetail, workSummaryOf } from "../src/boot-summary.js";

const RECENT = "/api/rooms/commons?messages=recent";
const SUMMARY = "/api/rooms/commons?view=summary";
const WORK = "/api/rooms/commons?view=work";
const response = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
const owner = { roomId: "commons", cursor: 0, viewerId: "human", viewerAccountId: "account-human", viewerAuthEpoch: 0, viewerSessionBinding: "session-human" };
const identity = () => ({ account: { id: "account-human", authEpoch: 0 }, member: { id: "human" }, roomId: "commons", csrf: "c", sessionBinding: "session-human" });
const at = n => new Date(Date.parse("2026-10-01T00:00:00Z") + n * 1000).toISOString();
const member = { id: "human", displayName: "Human", kind: "human", role: "owner", active: true, joinedAt: at(0), color: null, avatarUrl: null, bio: "", links: [] };
const channel = { id: "general", name: "General", topic: "", createdBy: "human", createdAt: at(0), archivedAt: null, position: 0 };
const record = (id, n) => ({ id, authorId: "human", body: `body ${id}`, channelId: "general", at: at(n), replyToId: null, editedAt: null, deletedAt: null, redactedAt: null, pinnedAt: null, revision: 0 });
const item = (id, state) => ({ id, title: `Item ${id}`, state, owner: null, sourceMessageId: null, body: "spec ".repeat(40), revision: 1 });
const workItems = { w1: item("w1", "unclaimed"), w2: item("w2", "claimed"), w3: item("w3", "done") };
const state = (messages, items = workItems) => ({
  room: { id: "commons", name: "Commons", createdBy: "human", createdAt: at(0) },
  members: { human: member }, channels: { general: channel }, messages, pins: [], workItems: items,
  eventLog: [], seenEvents: {}, seenIdempotencyKeys: {}
});
const recent = (sequence, messages, omitted) => ({ ...owner, sequence, state: state(messages),
  messagesWindow: { mode: "recent", limit: 3, omitted, older: "conversation" } });
const summary = (sequence, messages, omitted) => ({ ...owner, sequence, summaryVersion: 1, detailOwed: ["work"],
  workSummary: workSummaryOf(workItems), state: state(messages, {}),
  messagesWindow: { mode: "recent", limit: 3, omitted, older: "conversation" } });
const workView = sequence => ({ ...owner, snapshotView: "work", snapshotVersion: 1, sequence,
  state: { room: state([]).room, members: { human: member }, workItems } });
const refused = { error: { code: "invalid_snapshot_view", message: "Choose a supported snapshot view" } };
const bytes = value => Buffer.byteLength(JSON.stringify(value));

function fixture(t, route) {
  let stream;
  class Events extends EventTarget { constructor() { super(); stream = this; } close() {} }
  const reads = [], seen = [];
  const client = new RoomClient({ events: Events, lazyHistory: true, summaryBoot: route.summaryBoot ?? true,
    onSnapshot: value => seen.push(value), fetcher: async url => { reads.push(url); return route.read(url); } });
  client.session = identity();
  t.after(() => client.disconnect());
  return { client, reads, seen };
}

test("boot renders from the summary contract alone when the server serves it", async t => {
  const messages = [record("m1", 1), record("m2", 2), record("m3", 3)];
  const whole = recent(9, messages, 2), slim = summary(9, messages, 2);
  const f = fixture(t, { read: url => url === SUMMARY ? response(slim) : assert.fail(`no other boot read: ${url}`) });
  await f.client.refresh();
  assert.deepEqual(f.reads, [SUMMARY], "boot asked for the summary contract only");
  assert.ok(bytes(slim) < bytes(whole), "the summary is smaller than the windowed whole-state payload");
  const first = f.seen[0];
  assert.equal(isBootSummary(first), true);
  assert.deepEqual(first.state.workItems, {}, "no work detail in the first paint");
  assert.equal(first.workSummary.total, 3);
  assert.equal(first.state.messages.length, 3, "the message window still paints");
  assert.equal(f.client.summaryHeld, true);
  assert.deepEqual([...f.client.detailOwed], ["work"]);
});

test("staged fallback: a server without the contract gets one windowed read, slimmed locally", async t => {
  const messages = [record("m1", 1), record("m2", 2), record("m3", 3)];
  const whole = recent(9, messages, 2);
  const f = fixture(t, { read: url => url === SUMMARY ? response(refused, 422) : url === RECENT ? response(whole) : assert.fail(`unexpected read: ${url}`) });
  await f.client.refresh();
  assert.deepEqual(f.reads, [SUMMARY, RECENT], "one refused probe, then the ordinary windowed read");
  const first = f.seen[0];
  assert.equal(first.summaryStaged, true);
  assert.deepEqual(first.state.workItems, {});
  assert.equal(first.workSummary.total, 3);
  assert.equal(Object.keys(whole.state.workItems).length, 3, "derivation does not mutate the served snapshot");
});

test("a client without summaryBoot never probes the summary contract", async t => {
  const messages = [record("m1", 1)];
  const f = fixture(t, { summaryBoot: false, read: url => url === RECENT ? response(recent(9, messages, 0)) : assert.fail(`unexpected read: ${url}`) });
  await f.client.refresh();
  assert.deepEqual(f.reads, [RECENT]);
  assert.equal(f.client.summaryHeld, false);
  assert.equal(Object.keys(f.seen[0].state.workItems).length, 3, "default boot is unchanged");
});

test("loadViewDetail loads the owed work detail once, through the scoped work view", async t => {
  const messages = [record("m1", 1), record("m2", 2), record("m3", 3)];
  const f = fixture(t, { read: url => url === SUMMARY ? response(summary(9, messages, 2)) : url === WORK ? response(workView(9)) : assert.fail(`unexpected read: ${url}`) });
  await f.client.refresh();
  assert.equal(await f.client.loadViewDetail("work"), true);
  assert.deepEqual(f.reads, [SUMMARY, WORK]);
  assert.deepEqual(Object.keys(f.seen.at(-1).state.workItems).sort(), ["w1", "w2", "w3"]);
  assert.equal(f.client.summaryHeld, false);
  assert.deepEqual([...f.client.detailOwed], []);
  assert.equal(await f.client.loadViewDetail("work"), false, "nothing owed twice");
  assert.deepEqual(f.reads, [SUMMARY, WORK], "no second detail read");
});

test("while a summary is held, a covered message event re-reads instead of applying a delta", async t => {
  const messages = [record("m1", 1), record("m2", 2), record("m3", 3)];
  let served = summary(9, messages, 0);
  const f = fixture(t, { read: url => {
    if (url === SUMMARY) return response(served);
    if (url === RECENT) return response(recent(10, messages, 0));
    return assert.fail(`unexpected read: ${url}`);
  } });
  await f.client.refresh();
  assert.equal(f.client.heldMessages().partial, false, "complete window, so only the summary guard can decline");
  const receipt = { sequence: 10, event: { id: "e10", type: "message.posted", actorId: "human", roomId: "commons", at: at(10), data: { messageId: "m4", body: "new" } } };
  await f.client.refresh(receipt);
  assert.equal(f.client.deltaStats.reasons.summary, 1);
  assert.deepEqual(f.reads, [SUMMARY, RECENT], "the event fell back to a windowed read");
  assert.equal(f.client.summaryHeld, false, "the full-state read superseded the summary");
});

test("deriveBootSummary and mergeWorkDetail keep the contract shape", () => {
  const messages = [record("m1", 1)];
  const derived = deriveBootSummary(recent(9, messages, 0));
  assert.equal(isBootSummary(derived), true);
  assert.equal(derived.workSummary.total, 3);
  assert.deepEqual(derived.workSummary.byState, { unclaimed: 1, claimed: 1, done: 1 });
  assert.equal(deriveBootSummary(derived), derived, "deriving a summary is a no-op");
  const merged = mergeWorkDetail(derived, workView(9));
  assert.deepEqual(merged.detailOwed, []);
  assert.equal(Object.keys(merged.state.workItems).length, 3);
  assert.equal(merged.state.messages.length, 1, "detail merge keeps the held window");
});
