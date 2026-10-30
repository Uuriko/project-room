import test from "node:test";
import assert from "node:assert/strict";
import { PermissionBroker } from "../room-acp/src/permission.mjs";

const options = [{ kind: "allow_once", optionId: "allow" }, { kind: "reject_once", optionId: "deny" }];
const request = (threadKey = "root") => ({ threadKey, toolCall: { title: "Run action" }, options });
const choice = result => result.outcome.optionId;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ thread, post } = {}) {
  const replies = [], posts = [];
  const room = {
    post: async data => {
      const messageId = String(posts.length + 1); posts.push({ ...data, messageId });
      replies.push({ id: messageId, authorId: "agent", body: data.body });
      await post?.(data, messageId);
      return { messageId };
    },
    thread: async id => thread ? thread(id, replies) : { thread: { replies } },
    claimNote: async () => {},
  };
  const broker = new PermissionBroker({ room, approverId: "owner", timeoutMs: 100, pollMs: 1 });
  return { broker, room, replies, posts };
}

test("same-thread request is denied while first ask post is unresolved", async () => {
  const pendingPost = deferred();
  const { broker, posts, replies } = fixture({ post: data => data.body.startsWith("Permission needed") ? pendingPost.promise : undefined });
  const first = broker.request(request());
  assert.equal(broker.isPending("root"), true);
  assert.equal(choice(await broker.request(request())), "deny");
  assert.equal(posts.length, 1);
  assert.equal(broker.isPending("root"), true, "second request cannot clear first reservation");
  replies.push({ id: "answer", authorId: "owner", replyToId: "1", body: "allow" }); pendingPost.resolve();
  assert.equal(choice(await first), "allow");
  assert.equal(broker.isPending("root"), false);
});

test("earlier and delayed previous-ask approvals cannot approve a subsequent ask", async () => {
  let reads = 0;
  const { broker, replies } = fixture({ thread: (_id, entries) => {
    if (++reads === 1) entries.push({ id: "old-allow", authorId: "owner", replyToId: "1", body: "allow" });
    else entries.push({ id: "delayed-old-allow", authorId: "owner", replyToId: "1", body: "allow" });
    return { thread: { replies: entries } };
  } });
  assert.equal(choice(await broker.request(request())), "allow");
  assert.ok(replies.some(entry => entry.id === "old-allow"));
  broker.timeoutMs = 10;
  assert.equal(choice(await broker.request(request())), "deny");
});

test("abort during awaited thread read denies even when it returns owner allow", async () => {
  const controller = new AbortController();
  const { broker } = fixture({ thread: (_id, replies) => {
    controller.abort();
    return { thread: { replies: [...replies, { id: "allow", authorId: "owner", replyToId: "1", body: "allow" }] } };
  } });
  assert.equal(choice(await broker.request(request(), controller.signal)), "deny");
});

test("read resolving after deadline cannot authorize an action", async () => {
  const { broker } = fixture({ thread: async (_id, replies) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return { thread: { replies: [...replies, { id: "allow", authorId: "owner", replyToId: "1", body: "allow" }] } };
  } });
  broker.timeoutMs = 10;
  assert.equal(choice(await broker.request(request())), "deny");
});

test("pre-aborted request does not post an ask", async () => {
  const { broker, posts } = fixture(); const controller = new AbortController(); controller.abort();
  assert.equal(choice(await broker.request(request(), controller.signal)), "deny");
  assert.equal(posts.length, 0);
});

test("different claim DM asks remain independent while duplicate claim ask denies", async () => {
  const postGate = deferred();
  const { broker, posts } = fixture({
    post: data => data.body.startsWith("Permission needed") ? postGate.promise : undefined,
    thread: id => ({ thread: { replies: [{ id: "answer-" + id, authorId: "owner", replyToId: id, body: id === "1" ? "allow" : "deny" }] } }),
  });
  const first = broker.request(request("work-claim:one"));
  assert.equal(choice(await broker.request(request("work-claim:one"))), "deny");
  const second = broker.request(request("work-claim:two"));
  assert.equal(posts.length, 2); postGate.resolve();
  assert.deepEqual((await Promise.all([first, second])).map(choice), ["allow", "deny"]);
  assert.equal(broker.pending.size, 0); assert.equal(broker.askThreads.size, 0);
});
