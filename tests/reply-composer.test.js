import test from "node:test";
import assert from "node:assert/strict";
import { replyDraftKey, replyDraftData, validReplyDraft, confirmsReplyCommand } from "../src/reply-requests.js";
import { ConversationDrafts, DraftRecovery } from "../src/conversation.js";
import { draftCommand, RoomClient } from "../src/client.js";

const state = () => ({ members: { owner: {}, guest: {} }, messages: [{ id: "question" }],
  replyRequests: { question: { id: "question", requesterId: "owner", recipientId: "guest", workItemId: null, revision: 0 } } });
const mode = (kind = "answered") => ({ kind, requestMessageId: "question", expectedRequestRevision: 0,
  requesterId: "owner", workItemId: null, contextEventId: "context", contextSequence: 8 });
function recoveryFixture(selected = mode()) {
  const memory = new Map(), storage = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v), removeItem: k => memory.delete(k) };
  const recovery = new DraftRecovery(storage, () => 1000), drafts = new ConversationDrafts();
  const data = replyDraftData(selected, { body: "My response", toMemberId: "owner", replyToId: "question", messageId: "response" });
  const pending = draftCommand(null, selected.kind === "cancelled" ? "reply_request.cancelled" : "message.posted", data);
  const key = replyDraftKey(selected, "question");
  drafts.save(key, { body: "My response", toMemberId: "owner", replyToId: "question", mode: selected, threadId: "question", pending });
  drafts.save("question", { body: "Ordinary draft", replyToId: "question" });
  recovery.write("scope", drafts, "question", key);
  return { memory, recovery, drafts, key, pending };
}
test("request modes have distinct draft identities and exact permitted fields", () => {
  const keys = [null, "question", ...["answered", "declined", "cancelled"].map(kind => replyDraftKey(mode(kind))), replyDraftKey({ kind: "request" }, "question")];
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(validReplyDraft(mode(), state()));
  for (const patch of [{ kind: "other" }, { requesterId: "guest" }, { workItemId: "other" }, { expectedRequestRevision: 1 }, { contextSequence: 0 }, { extra: 1 }])
    assert.ok(!validReplyDraft({ ...mode(), ...patch }, state()));
});
test("answer, decline and cancellation retries recover exactly even after terminal change", () => {
  for (const kind of ["answered", "declined", "cancelled"]) {
    const f = recoveryFixture(mode(kind)), s = state(); s.replyRequests.question.revision = 1; s.replyRequests.question.status = kind;
    const result = f.recovery.read("scope", s);
    assert.equal(result.activeKey, f.key); assert.equal(result.threadId, "question");
    assert.deepEqual(result.drafts.get(f.key).pending, f.pending);
    assert.equal(result.drafts.get("question").body, "Ordinary draft");
  }
});
test("corrupted request retry is dropped, never converted to a fresh send", () => {
  for (const change of [d => { d.pending.id = 123; }, d => { d.body = "Changed"; }, d => { d.pending.contents = "{}"; }, d => { d.pending.messageId = "different"; }]) {
    const f = recoveryFixture(), saved = JSON.parse(f.memory.get(f.recovery.key)); change(saved.entries[0][1]);
    f.memory.set(f.recovery.key, JSON.stringify(saved));
    assert.equal(f.recovery.read("scope", state()).drafts.entries.has(f.key), false);
  }
});
test("unsent request without a recipient survives recovery, while old ordinary v2 remains readable", () => {
  const f = recoveryFixture(), key = replyDraftKey({ kind: "request" });
  f.drafts.save(key, { body: "Who can help?", toMemberId: "", replyToId: null, threadId: null, mode: { kind: "request" } });
  f.recovery.write("scope", f.drafts, null, key);
  assert.equal(f.recovery.read("scope", state()).drafts.get(key).body, "Who can help?");
  f.memory.clear(); f.memory.set("project-room:drafts:v2", JSON.stringify({ scope: "scope", expires: 2000, threadId: "question",
    entries: [["question", { body: "Legacy draft", toMemberId: "", replyToId: "question", pending: null }]] }));
  assert.equal(f.recovery.read("scope", state()).drafts.get("question").body, "Legacy draft");
});
test("only an exact owned service receipt confirms a request write", async () => {
  const command = { id: "send", type: "message.posted", data: replyDraftData(mode(), { body: "Answer", messageId: "response" }) };
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("guest:send"));
  const receipt = { sequence: 9, duplicate: false, event: { id: "event", roomId: "commons", actorId: "guest", type: command.type,
    causationId: null, idempotencyKey: Buffer.from(hash).toString("hex"), data: { ...command.data, requestPolicyVersion: 1 } } };
  assert.equal(await confirmsReplyCommand(receipt, command, "commons", "guest"), true);
  for (const change of [r => { r.sequence = 0; }, r => { r.event.actorId = "owner"; }, r => { r.event.idempotencyKey = "wrong"; },
    r => { r.event.data.contextSequence++; }, r => { r.event.data.extra = true; }, r => { r.event.data.responseOutcome = "declined"; }]) {
    const wrong = structuredClone(receipt); change(wrong); assert.equal(await confirmsReplyCommand(wrong, command, "commons", "guest"), false);
  }
});
const identity = { roomId: "commons", member: { id: "guest" }, account: { id: "account", authEpoch: 0 }, sessionBinding: "binding" };
function selected(cursor = null) {
  return { contractVersion: 1, roomId: "commons", viewerId: "guest", viewerAccountId: "account", viewerAuthEpoch: 0, viewerSessionBinding: "binding",
    selection: { requestMessageId: "question" }, request: { id: "question" }, page: {
      cursor, afterSequence: cursor ? 1 : 0, horizonSequence: 2, horizonEventId: "horizon", hasMore: !cursor, nextCursor: cursor ? null : "next",
      items: [{ requestMessageId: "question", sequence: cursor ? 2 : 1 }]
    } };
}
test("browser selected context walks the frozen pages and refuses changed ownership or progress", async () => {
  for (const mutate of [null, r => { r.viewerAccountId = "other"; }, r => { r.page.horizonSequence = 3; },
    r => { r.page.afterSequence = 0; }, r => { r.page.items[0].sequence = 1; }, r => { r.page.nextCursor = "next"; }]) {
    let calls = 0;
    const client = new RoomClient({ fetcher: async () => { const result = selected(calls++ ? "next" : null); if (mutate && calls === 2) mutate(result); return { ok: true, json: async () => result }; } });
    client.session = structuredClone(identity);
    if (mutate) await assert.rejects(client.replyContext("question"));
    else assert.equal((await client.replyContext("question")).page.hasMore, false);
    assert.equal(calls, 2);
  }
});
test("late selected context cannot activate a replacement session", async () => {
  let release;
  const client = new RoomClient({ fetcher: () => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => selected() }); }) });
  client.session = structuredClone(identity); const read = client.replyContext("question");
  client.disconnect(); client.session = { ...identity, sessionBinding: "replacement" }; release();
  await assert.rejects(read, /identity changed/); assert.equal(client.session.sessionBinding, "replacement");
});
