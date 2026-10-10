import test from "node:test";
import assert from "node:assert/strict";
import { antiLoopCounts, agentsTalkingRuns } from "../src/anti-loop.js";

const members = { ana: { kind: "human" }, a1: { kind: "agent" }, a2: { kind: "agent" } };
const msg = (id, authorId, extra = {}) => ({ id, authorId, createdAt: `2026-10-09T17:0${id.length}:00Z`, ...extra });

test("counts agent posts since the last person, and the viewer's own share", () => {
  const list = [msg("p", "ana"), msg("x1", "a1"), msg("x2", "a2"), msg("x3", "a1")];
  assert.deepEqual(antiLoopCounts(list, members, "a1"), { lastPersonMessageId: "p", lastPersonMessageAt: list[0].createdAt, agentMessagesSincePerson: 3, yoursSincePerson: 2 });
  assert.equal(antiLoopCounts(list, members, "a2").yoursSincePerson, 1);
});

test("a person posting resets the counter; deleted posts do not count", () => {
  const list = [msg("x1", "a1"), msg("p", "ana"), msg("x2", "a1", { deleted: true })];
  assert.deepEqual(antiLoopCounts(list, members, "a1"), { lastPersonMessageId: "p", lastPersonMessageAt: list[1].createdAt, agentMessagesSincePerson: 0, yoursSincePerson: 0 });
});

test("unknown authors count as people, so a bad member list never inflates the count", () => {
  assert.equal(antiLoopCounts([msg("x1", "a1"), msg("q", "ghost"), msg("x2", "a2")], members).agentMessagesSincePerson, 1);
  assert.equal(antiLoopCounts([msg("x1", "a1")], {}).agentMessagesSincePerson, 0);
});

test("an all-agent room has no last person and counts every post", () => {
  const counts = antiLoopCounts([msg("x1", "a1"), msg("x2", "a2")], members, null);
  assert.equal(counts.lastPersonMessageId, null);
  assert.equal(counts.agentMessagesSincePerson, 2);
  assert.equal(counts.yoursSincePerson, 0);
  assert.deepEqual(antiLoopCounts([], members), { lastPersonMessageId: null, lastPersonMessageAt: null, agentMessagesSincePerson: 0, yoursSincePerson: 0 });
});

test("three or more agent posts in a row fold; two do not; kept kinds break the run", () => {
  const list = [msg("p", "ana"), msg("x1", "a1"), msg("x2", "a2"), msg("p2", "ana"), msg("y1", "a1"), msg("y2", "a2"), msg("y3", "a1"), msg("q", "a2", { kind: "question" }), msg("z1", "a1")];
  assert.deepEqual(agentsTalkingRuns(list, members, { keep: m => m.kind === "question" }), [{ start: 4, end: 7, count: 3 }]);
  assert.deepEqual(agentsTalkingRuns(list, members), [{ start: 4, end: 9, count: 5 }], "without keep the question folds too");
});

test("room_read_messages carries the anti-loop counts for the reader, ignoring DMs between others", async t => {
  const { RoomStore } = await import("../server/store.mjs");
  const { initialRoom } = await import("../server/bootstrap.mjs");
  const { callHostedStdioTool } = await import("../server/mcp-full-profile.mjs");
  const { PERMISSIONS } = await import("../src/events.js");
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  for (const id of ["a1", "a2"]) {
    store.command(keys.owner, "commons", { id: `join-${id}`, type: "member.added", data: { memberId: id, displayName: id, kind: "agent", permissions: [...PERMISSIONS] } });
    keys[id] = store.issueAccessKey("commons", id);
  }
  const post = (who, messageId, extra = {}) => store.command(keys[who], "commons", { id: `post-${messageId}`, type: "message.posted", data: { messageId, body: messageId, ...extra } });
  post("owner", "p1"); post("a1", "x1"); post("a2", "x2"); post("a1", "x3");
  post("a2", "dm", { toMemberId: "owner" });
  const read = async who => (await callHostedStdioTool(store, keys[who], "room_read_messages", { roomId: "commons", latest: true, limit: 10 })).value.antiLoop;
  assert.deepEqual(await read("a1"), { lastPersonMessageId: "p1", lastPersonMessageAt: (await read("a1")).lastPersonMessageAt, agentMessagesSincePerson: 3, yoursSincePerson: 2 });
  assert.equal((await read("a2")).agentMessagesSincePerson, 4, "a2 sees its own DM to the owner");
  assert.equal((await read("owner")).agentMessagesSincePerson, 4, "the DM's recipient sees it");
  post("owner", "p2");
  assert.equal((await read("a1")).agentMessagesSincePerson, 0, "a person post resets it");
});
