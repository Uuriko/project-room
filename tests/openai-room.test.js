import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { completeChat } from "../server/openai-complete.mjs";
import { replyOnce, openJournal } from "../scripts/room-openai-once.mjs";

const env = { PROJECT_ROOM_OPENAI_API_KEY: "synthetic-provider-key" };
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-openai-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-ai", type: "member.added", data: {
    memberId: "ai", displayName: "OpenAI test", kind: "agent", permissions: [], accountableHumanId: "owner"
  } });
  const token = store.issueAccessKey("commons", "ai");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = new RoomAgentClient({ origin, roomId: "commons", token: ownerKey });
  const client = new RoomAgentClient({ origin, roomId: "commons", token });
  const filename = join(directory, "journal.sqlite");
  const db = openJournal(filename);
  t.after(async () => {
    db.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  await owner.command({ id: "ask", type: "message.posted", data: { messageId: "question", body: "Hello OpenAI", toMemberId: "ai" } });
  return { client, owner, db, origin, roomId: "commons", messageId: "question", env };
}

test("real Room HTTP and SQLite: one reply, visible to human, rerun makes no second provider call", async t => {
  const f = await fixture(t); let calls = 0;
  const complete = async ({ text }) => { calls++; assert.equal(text, "Hello OpenAI"); return { text: "Hello from the fixture" }; };
  const result = await replyOnce({ ...f, complete });
  const messages = (await f.owner.snapshot()).state.messages;
  const reply = messages.find(m => m.id === result.messageId);
  assert.equal(reply.authorId, "ai"); assert.equal(reply.replyToId, "question"); assert.equal(reply.toMemberId, "owner");
  assert.equal(reply.body, "Hello from the fixture");
  assert.equal((await replyOnce({ ...f, complete })).duplicate, true); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(messages).includes(env.PROJECT_ROOM_OPENAI_API_KEY));
});

test("lost Room response resumes saved command without another model call", async t => {
  const f = await fixture(t); let calls = 0; let command;
  const transport = { snapshot: () => f.client.snapshot(), command: async value => { command = value; throw new Error("lost before receipt"); } };
  const complete = async () => { calls++; return { text: "Saved answer" }; };
  await assert.rejects(replyOnce({ ...f, client: transport, complete }));
  const result = await replyOnce({ ...f, complete });
  assert.equal(result.messageId, command.id); assert.equal(calls, 1);
});

test("uncertain provider result is not silently charged again", async t => {
  const f = await fixture(t); let calls = 0;
  const complete = async () => { calls++; throw new Error("provider timeout"); };
  await assert.rejects(replyOnce({ ...f, complete }));
  await assert.rejects(replyOnce({ ...f, complete }), /uncertain outcome/);
  assert.equal(calls, 1);
  assert.equal((await f.owner.snapshot()).state.messages.length, 1);
});

test("agent-authored and unaddressed messages never invoke provider", async t => {
  const f = await fixture(t); let calls = 0;
  const complete = async () => { calls++; return { text: "unexpected" }; };
  await f.client.command({ id: "self", type: "message.posted", data: { messageId: "self-msg", body: "Reply to me", toMemberId: "ai" } });
  await f.owner.command({ id: "general", type: "message.posted", data: { messageId: "general-msg", body: "General chat" } });
  for (const messageId of ["self-msg", "general-msg"]) await assert.rejects(replyOnce({ ...f, messageId, complete }), /human message addressed/);
  assert.equal(calls, 0);
});

test("provider call has fixed endpoint, cap, timeout and no Room credential", async () => {
  let call;
  const result = await completeChat({ text: "Synthetic test", env, fetchImpl: async (url, options) => {
    call = { url, options }; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }) };
  } });
  assert.equal(result.text, "OK"); assert.equal(call.url, "https://api.openai.com/v1/chat/completions");
  const body = JSON.parse(call.options.body); assert.equal(body.max_completion_tokens, 256); assert.equal(body.store, false);
  assert.equal(call.options.redirect, "error"); assert.ok(call.options.signal);
  assert.ok(!call.options.body.includes(env.PROJECT_ROOM_OPENAI_API_KEY));
});

test("missing key and provider errors fail without a fake answer", async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return { ok: false, status: 401 }; };
  await assert.rejects(completeChat({ text: "test", env: {}, fetchImpl }), /missing/); assert.equal(calls, 0);
  await assert.rejects(completeChat({ text: "test", env, fetchImpl }), /HTTP 401/);
});
