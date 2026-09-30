import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { readChannel, channelCommand, roomLines, lineId, sync } from "../scripts/disk-door.mjs";

test("channel reader skips door lines, junk and half-written lines", () => {
  const a = JSON.stringify({ from: "claude", body: "hi" }), b = JSON.stringify({ from: "room:Grok", body: "echo" });
  const text = `${a}\nnot json\n${b}\n{"from":"grok","body":"half`;
  const r = readChannel(text);
  assert.deepEqual(r.entries.map(e => e.from), ["claude"]);
  assert.equal(r.offset, text.lastIndexOf("\n") + 1);
  assert.equal(readChannel(text, r.offset).entries.length, 0);
});

test("channel command is attributed with a stable id; room lines skip self and private", () => {
  const raw = JSON.stringify({ from: "claude", body: "hello" });
  const c = channelCommand({ raw, from: "claude", body: "hello" });
  assert.equal(c.id, lineId(raw)); assert.equal(c.data.body, "**claude** via Mac channel (unverified): hello");
  const { lines, cursor } = roomLines([
    { sequence: 3, from: "door", body: "mine" }, { sequence: 4, from: "owner", body: "yo", messageId: "m4" },
    { sequence: 5, from: "owner", body: "dm", private: true }], { selfMemberId: "door", names: { owner: "John" }, cursor: 2 });
  assert.equal(cursor, 5); assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).from, "room:John");
});

test("real Room: first sync starts at the end, then relays both ways exactly once", async t => {
  const directory = mkdtempSync(join(tmpdir(), "disk-door-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-door", type: "member.added", data: {
    memberId: "door", displayName: "Mac channel", kind: "agent", permissions: [], accountableHumanId: "owner" } });
  setTier(store.db, "commons", "door", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const token = store.issueAccessKey("commons", "door");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const owner = new RoomAgentClient({ origin, roomId: "commons", token: ownerKey });
  const door = new RoomAgentClient({ origin, roomId: "commons", token });
  const channel = join(directory, "channel.jsonl"), stateFile = join(directory, "state.json");
  writeFileSync(channel, JSON.stringify({ from: "grok", body: "old history" }) + "\n");
  await owner.say("old room message");
  assert.equal((await sync({ client: door, channel, stateFile, selfMemberId: "door" })).started, true);

  appendFileSync(channel, JSON.stringify({ from: "claude", body: "new from the Mac" }) + "\n");
  await owner.say("new from the room");
  const r = await sync({ client: door, channel, stateFile, selfMemberId: "door" });
  assert.equal(r.sent, 1); assert.equal(r.received, 1);
  const bodies = (await owner.snapshot()).state.messages.map(m => m.body);
  assert.ok(bodies.includes("**claude** via Mac channel (unverified): new from the Mac"));
  assert.ok(!bodies.some(b => b.includes("old history")));
  const lines = readFileSync(channel, "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(lines.at(-1).body, "new from the room"); assert.ok(!lines.some(l => l.body === "old room message"));

  const again = await sync({ client: door, channel, stateFile, selfMemberId: "door" });
  assert.equal(again.sent, 0); assert.equal(again.received, 0);
});

test("peer append during an awaited relay is read next time and outbound lines never loop", async t => {
  const directory = mkdtempSync(join(tmpdir(), "disk-door-concurrent-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const channel = join(directory, "channel.jsonl"), stateFile = join(directory, "state.json");
  writeFileSync(channel, JSON.stringify({ from: "claude", body: "first" }) + "\n");
  writeFileSync(stateFile, JSON.stringify({ offset: 0, seq: 0 }));
  const commands = []; let appended = false;
  const client = {
    command: async command => { commands.push(command); },
    roomMessages: async ({ after }) => {
      if (!appended) { appended = true; appendFileSync(channel, JSON.stringify({ from: "grok", body: "during relay" }) + "\n"); }
      return { messages: after < 1 ? [{ sequence: 1, from: "owner", messageId: "room-1", body: "from room" }] : [], next: 1, hasMore: false };
    }
  };
  assert.equal((await sync({ client, channel, stateFile, selfMemberId: "door" })).sent, 1);
  assert.equal((await sync({ client, channel, stateFile, selfMemberId: "door" })).sent, 1);
  assert.equal((await sync({ client, channel, stateFile, selfMemberId: "door" })).sent, 0);
  assert.equal(commands.length, 2);
  assert.match(commands[1].data.body, /during relay/);
  assert.ok(commands.every(command => !command.data.body.includes("from room")));
});
