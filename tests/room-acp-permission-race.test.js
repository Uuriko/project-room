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

for (const ending of ["abort", "deadline"]) {
  test(`${ending} during approval receipt post denies with truthful follow-up`, async () => {
    const controller = new AbortController();
    const receiptStarted = deferred(), receiptFinish = deferred();
    const { broker, posts } = fixture({
      thread: id => ({ thread: { replies: [{ id: "answer", authorId: "owner", replyToId: id, body: "allow" }] } }),
      post: data => {
        if (data.body.startsWith("Approval received:")) { receiptStarted.resolve(); return receiptFinish.promise; }
      },
    });
    broker.timeoutMs = ending === "deadline" ? 50 : 1000;
    const result = broker.request(request(), controller.signal);
    await receiptStarted.promise;
    if (ending === "abort") controller.abort();
    else await new Promise(resolve => setTimeout(resolve, 60));
    receiptFinish.resolve();
    assert.equal(choice(await result), "deny");
    assert.ok(posts.some(post => post.body.startsWith("Approval received:")));
    assert.match(posts.at(-1).body, /^Denied: .*ended before approval could be forwarded/);
    assert.ok(posts.every(post => !/^Allowed:/.test(post.body)));
    assert.equal(broker.pending.size, 0);
  });
}

test("plain Room allow never falls back to a persistent host grant", async () => {
  const { broker, posts } = fixture();
  const logs = []; broker.log = line => logs.push(line);
  const result = await broker.request({ ...request(), options: [
    { kind: "allow_always", optionId: "persistent" }, { kind: "reject_once", optionId: "deny" },
  ] });
  assert.equal(choice(result), "deny");
  assert.equal(posts.length, 0);
  assert.match(logs[0], /only persistent approval/);
});

test("one-time approval wins when persistent approval is also offered", async () => {
  const { broker } = fixture({ thread: id => ({ thread: { replies: [{ id: "answer", authorId: "owner", replyToId: id, body: "allow" }] } }) });
  const result = await broker.request({ ...request(), options: [{ kind: "allow_always", optionId: "persistent" }, ...options] });
  assert.equal(choice(result), "allow");
});


test("persistent-only denial cancels rather than changing host policy", async () => {
  const { broker } = fixture({ thread: id => ({ thread: { replies: [{ authorId: "owner", replyToId: id, body: "deny" }] } }) });
  const result = await broker.request({ ...request(), options: [options[0], { kind: "reject_always", optionId: "persistent-deny" }] });
  assert.deepEqual(result, { outcome: { outcome: "cancelled" } });
});

test("failed approval receipt fails closed instead of silently granting", async () => {
  const { broker } = fixture({
    thread: id => ({ thread: { replies: [{ authorId: "owner", replyToId: id, body: "allow" }] } }),
    post: data => { if (data.body.startsWith("Approval received:")) throw new Error("offline"); },
  });
  assert.equal(choice(await broker.request(request())), "deny");
});

test("latest owner correction in the same poll snapshot wins", async () => {
  const { broker } = fixture({ thread: id => ({ thread: { replies: [
    { authorId: "owner", replyToId: id, body: "allow" },
    { authorId: "owner", replyToId: id, body: "deny" },
  ] } }) });
  assert.equal(choice(await broker.request(request())), "deny");
});

test("failed abort correction leaves a conditional receipt and logs failure", async () => {
  const controller = new AbortController(), logs = [];
  const { broker, posts } = fixture({
    thread: id => ({ thread: { replies: [{ authorId: "owner", replyToId: id, body: "allow" }] } }),
    post: data => {
      if (data.body.startsWith("Approval received:")) controller.abort();
      if (data.body.startsWith("Denied:")) throw new Error("offline correction");
    },
  });
  broker.log = line => logs.push(line);
  assert.equal(choice(await broker.request(request(), controller.signal)), "deny");
  assert.match(posts.find(p => p.body.startsWith("Approval received:")).body, /only to this request if it is still active; this is not an execution receipt/);
  assert.ok(logs.some(line => line.includes("denial receipt failed")));
});


test("changed approval authority after an answer blocks the grant", async () => {
  const { broker } = fixture({ thread: id => ({ thread: { replies: [{ authorId: "owner", replyToId: id, body: "allow" }] } }) });
  let validations = 0;
  assert.equal(choice(await broker.request({ ...request(), validateApproval: async () => { validations++; return false; } })), "deny");
  assert.equal(validations, 1);
});

test("failed authority recheck blocks the grant", async () => {
  const { broker } = fixture({ thread: id => ({ thread: { replies: [{ authorId: "owner", replyToId: id, body: "allow" }] } }) });
  assert.equal(choice(await broker.request({ ...request(), validateApproval: async () => { throw new Error("offline"); } })), "deny");
});
