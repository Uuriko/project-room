// Summary-first boot, reconciled onto RR-D2's scoped-projection
// grammar (GC7-C): a client created with summaryBoot renders its first
// paint from the boot class set of the projection endpoint (see
// src/boot-summary.js for the grammar) instead of the windowed
// snapshot's whole state, and loads detail per view — the board's
// work items through the scoped work view — only when a view asks
// for it. The endpoint lands after this client, so the boot probes
// it once per session and, until it exists, derives the identical
// grammar locally from the windowed read (staged mode).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomClient } from "../src/client.js";
import { deriveBootSummary, isBootSummary, isProjectionRead, bootSummaryFromProjection, mergeWorkDetail, BOOT_FIELDS, BOOT_PROJECTION_PATH } from "../src/boot-summary.js";

const RECENT = "/api/rooms/commons?messages=recent";
const PROJECTION = "/api/rooms/commons/projection?fields=summary,room,members,channels,messages,audit,pins,bonds";
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
// The endpoint's envelope for the boot class set, shaped exactly as
// the projection core serves it: state carries only the requested
// classes' keys, the summary pseudo-class rides as { room, counts },
// and omittedClasses names the one class present but not requested.
const projection = (sequence, messages, omitted) => ({ ...owner, projectionVersion: 1, sequence,
  fields: [...BOOT_FIELDS],
  returnedClasses: ["room", "members", "channels", "messages", "audit", "pins", "bonds"],
  omittedClasses: ["work"],
  summary: { room: state(messages).room, counts: { members: 1, channels: 1, messages: messages.length, workItems: 3, pins: 0, eventLog: 0, bonds: 0 } },
  state: { room: state(messages).room, members: { human: member }, channels: { general: channel }, messages, pins: [], eventLog: [], bonds: {} },
  messagesWindow: { mode: "recent", limit: 3, omitted, older: "conversation" },
  catchUpCursor: sequence });
const workView = sequence => ({ ...owner, snapshotView: "work", snapshotVersion: 1, sequence,
  state: { room: state([]).room, members: { human: member }, workItems } });
const refused = { error: { code: "not_found", message: "no such route" } };
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

test("the boot class set is the projection grammar's, in canonical order", () => {
  assert.deepEqual([...BOOT_FIELDS], ["summary", "room", "members", "channels", "messages", "audit", "pins", "bonds"]);
  assert.equal(BOOT_PROJECTION_PATH, "/projection?fields=summary,room,members,channels,messages,audit,pins,bonds");
});

test("boot renders from the projection envelope alone when the endpoint serves it", async t => {
  const messages = [record("m1", 1), record("m2", 2), record("m3", 3)];
  const whole = recent(9, messages, 2), slim = projection(9, messages, 2);
  const f = fixture(t, { read: url => url === PROJECTION ? response(slim) : assert.fail(`no other boot read: ${url}`) });
  await f.client.refresh();
  assert.deepEqual(f.reads, [PROJECTION], "boot asked for the boot class set only");
  assert.ok(bytes(slim) < bytes(whole), "the projection is smaller than the windowed whole-state payload");
  const first = f.seen[0];
  assert.equal(isBootSummary(first), true);
  assert.equal(isProjectionRead(first), true, "the held boot summary keeps the served envelope's grammar fields");
  assert.deepEqual(first.state.workItems, {}, "no work detail in the first paint");
  assert.equal(first.summary.counts.workItems, 3, "the summary class counts the work it does not carry");
  assert.equal(first.summary.room.id, "commons");
  assert.equal(first.state.messages.length, 3, "the message window still paints");
  assert.equal(f.client.summaryHeld, true);
  assert.deepEqual([...f.client.detailOwed], ["work"], "the owed set is the envelope's omitted work class");
});

test("staged fallback: no endpoint yet gets one windowed read, slimmed into the same grammar", async t => {
  const messages = [record("m1", 1), record("m2", 2), record("m3", 3)];
  const whole = recent(9, messages, 2);
  const f = fixture(t, { read: url => url === PROJECTION ? response(refused, 404) : url === RECENT ? response(whole) : assert.fail(`unexpected read: ${url}`) });
  await f.client.refresh();
  assert.deepEqual(f.reads, [PROJECTION, RECENT], "one refused probe, then the ordinary windowed read");
  const first = f.seen[0];
  assert.equal(first.summaryStaged, true);
  assert.equal(first.projectionVersion, 1);
  assert.deepEqual(first.fields, [...BOOT_FIELDS]);
  assert.deepEqual(first.omittedClasses, ["work"]);
  assert.deepEqual(first.state.workItems, {});
  assert.equal(first.summary.counts.workItems, 3);
  assert.equal(Object.keys(whole.state.workItems).length, 3, "derivation does not mutate the served snapshot");
});

test("a client without summaryBoot never probes the projection endpoint", async t => {
  const messages = [record("m1", 1)];
  const f = fixture(t, { summaryBoot: false, read: url => url === RECENT ? response(recent(9, messages, 0)) : assert.fail(`unexpected read: ${url}`) });
  await f.client.refresh();
  assert.deepEqual(f.reads, [RECENT]);
  assert.equal(f.client.summaryHeld, false);
  assert.equal(Object.keys(f.seen[0].state.workItems).length, 3, "default boot is unchanged");
});

test("loadViewDetail loads the owed work detail once, through the scoped work view", async t => {
  const messages = [record("m1", 1), record("m2", 2), record("m3", 3)];
  const f = fixture(t, { read: url => url === PROJECTION ? response(projection(9, messages, 2)) : url === WORK ? response(workView(9)) : assert.fail(`unexpected read: ${url}`) });
  await f.client.refresh();
  assert.equal(await f.client.loadViewDetail("work"), true);
  assert.deepEqual(f.reads, [PROJECTION, WORK]);
  assert.deepEqual(Object.keys(f.seen.at(-1).state.workItems).sort(), ["w1", "w2", "w3"]);
  assert.equal(f.client.summaryHeld, false);
  assert.deepEqual([...f.client.detailOwed], []);
  assert.equal(await f.client.loadViewDetail("work"), false, "nothing owed twice");
  assert.deepEqual(f.reads, [PROJECTION, WORK], "no second detail read");
});

test("while a summary is held, a covered message event re-reads instead of applying a delta", async t => {
  const messages = [record("m1", 1), record("m2", 2), record("m3", 3)];
  let served = projection(9, messages, 0);
  const f = fixture(t, { read: url => {
    if (url === PROJECTION) return response(served);
    if (url === RECENT) return response(recent(10, messages, 0));
    return assert.fail(`unexpected read: ${url}`);
  } });
  await f.client.refresh();
  assert.equal(f.client.heldMessages().partial, false, "complete window, so only the summary guard can decline");
  const receipt = { sequence: 10, event: { id: "e10", type: "message.posted", actorId: "human", roomId: "commons", at: at(10), data: { messageId: "m4", body: "new" } } };
  await f.client.refresh(receipt);
  assert.equal(f.client.deltaStats.reasons.summary, 1);
  assert.deepEqual(f.reads, [PROJECTION, RECENT], "the event fell back to a windowed read");
  assert.equal(f.client.summaryHeld, false, "the full-state read superseded the summary");
});

test("deriveBootSummary, bootSummaryFromProjection and mergeWorkDetail keep the grammar shape", () => {
  const messages = [record("m1", 1)];
  const derived = deriveBootSummary(recent(9, messages, 0));
  assert.equal(isBootSummary(derived), true);
  assert.deepEqual(derived.returnedClasses, ["room", "members", "channels", "messages", "audit", "pins"]);
  assert.deepEqual(derived.summary.counts, { members: 1, channels: 1, messages: 1, workItems: 3, pins: 0, eventLog: 0, bonds: 0 });
  assert.equal(deriveBootSummary(derived), derived, "deriving a boot summary is a no-op");
  const adapted = bootSummaryFromProjection(projection(9, messages, 0));
  assert.equal(isBootSummary(adapted), true);
  assert.deepEqual(adapted.detailOwed, ["work"]);
  assert.equal(adapted.state.messages.length, 1);
  assert.equal(bootSummaryFromProjection(recent(9, messages, 0)), null, "a non-projection read is not adapted");
  const merged = mergeWorkDetail(adapted, workView(9));
  assert.deepEqual(merged.detailOwed, []);
  assert.equal(Object.keys(merged.state.workItems).length, 3);
  assert.equal(merged.state.messages.length, 1, "detail merge keeps the held window");
});
