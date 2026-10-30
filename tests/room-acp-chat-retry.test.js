import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { Bridge } from "../room-acp/src/bridge.mjs";
import { RoomClient } from "../room-acp/src/room.mjs";
import { join } from "../room-acp/src/join.mjs";
import { startRoom } from "./room-acp-fixture.mjs";

const wake = id => ({ signalId: id, messageId: id, author: "owner", body: `Do ${id}` });
function setup(t) {
  const home = mkdtempSync(pathJoin(tmpdir(), "chat-retry-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const counts = { prompts: [], posts: [], acks: [] };
  const make = () => {
    const bridge = new Bridge({ connection: { apiBase: "http://localhost", roomId: "r", memberId: "agent", hostId: "h" }, env: { ROOM_ACP_HOME: home }, host: {
      session: async () => ({ sessionId: "s", created: true }),
      prompt: async (_key, prompt) => { counts.prompts.push(prompt); return { recorder: { text: "completed", tools: new Map() }, stopReason: "end_turn" }; },
    } });
    bridge.fencingToken = "test-listener";
    bridge.room.checkListener = async () => ({ listener: { valid: true } });
    bridge.room.room = async () => ({ state: { room: { ownerId: "owner" }, members: { owner: { id: "owner", kind: "human", active: true }, [bridge.connection.memberId]: { id: "agent", active: true } } } });
    bridge.room.thread = async () => ({ thread: { id: "root", authorId: "owner", body: "Original request", replies: [] } });
    bridge.room.post = async args => { counts.posts.push(args); };
    bridge.room.ack = async args => { counts.acks.push(args.signalIds); };
    return bridge;
  };
  return { make, counts };
}

test("lost chat ack retries only ack after restart and split batch delivery", async t => {
  const { make, counts } = setup(t);
  const first = make(); first.room.ack = async () => { throw Error("lost ack"); };
  await first.turn("root", [wake("a"), wake("b")]);
  const restarted = make();
  await restarted.turn("root", [wake("b")]);
  await restarted.turn("root", [wake("a")]);
  assert.equal(counts.prompts.length, 1);
  assert.equal(counts.posts.length, 1);
  assert.deepEqual(counts.acks, [["a", "b"], ["a", "b"]]);
});

test("lost chat result replays identical command and message IDs across rebatching", async t => {
  const { make, counts } = setup(t);
  const first = make();
  first.room.post = async args => { counts.posts.push(args); throw Error("response lost"); };
  await first.turn("root", [wake("a"), wake("b")]);
  await make().turn("root", [wake("b"), wake("c"), wake("a")]);
  assert.equal(counts.prompts.length, 2);
  assert.deepEqual(counts.posts[0], counts.posts[1]);
  assert.notEqual(counts.posts[1].requestId, counts.posts[2].requestId);
  const newPrompt = JSON.stringify(counts.prompts[1]);
  assert.match(newPrompt, /Do c/);
  assert.doesNotMatch(newPrompt, /Do a|Do b/);
});

test("failure retrying an old result does not strand newly batched work", async t => {
  const { make, counts } = setup(t);
  const first = make(); first.room.post = async () => { throw Error("network"); };
  await first.turn("root", [wake("a")]);
  const restarted = make(); restarted.room.post = async () => { throw Error("network"); };
  await restarted.turn("root", [wake("a"), wake("b")]);
  await make().turn("root", [wake("b"), wake("a")]);
  assert.equal(counts.prompts.length, 2);
  assert.equal(counts.posts.length, 2);
});

test("interrupted grouped chat execution never silently repeats", async t => {
  const { make, counts } = setup(t);
  const first = make();
  first.host.prompt = async () => { counts.prompts.push("external action started"); first.stop(); throw Error("interrupted"); };
  await first.turn("root", [wake("a"), wake("b")]);
  await make().turn("root", [wake("b")]);
  await make().turn("root", [wake("a")]);
  assert.equal(counts.prompts.length, 1);
  assert.equal(counts.posts.length, 0);
  assert.equal(counts.acks.length, 0);
});

test("real Room API deduplicates stable reply command IDs", async t => {
  const fixture = await startRoom(t);
  const connection = await join({ link: fixture.invite().link, displayName: "Retry agent", env: fixture.env });
  const client = new RoomClient(connection);
  const rootId = fixture.say("Please work");
  const args = { body: "One reply", replyToId: rootId, messageId: "stable-reply", requestId: "stable-command" };
  await client.post(args); await client.post(args);
  assert.equal(fixture.messages().filter(message => message.id === "stable-reply").length, 1);
  const thread = await client.thread(rootId);
  assert.equal(thread.thread.replies.filter(message => message.id === "stable-reply").length, 1);
});
