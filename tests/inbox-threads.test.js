// A010: thread view. Pure thread-builder tests; no store, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { buildThreads, threadFor, ThreadError } from "../server/inbox-threads.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ThreadError && error.code === code);
const msg = (id, occurredAt, extras = {}) => ({ id, occurredAt, subject: `s-${id}`, ...extras });

test("groups by threadId and flattens oldest-first with depth", () => {
  const threads = buildThreads([
    msg("r1", "2026-09-16T09:00:00Z", { threadId: "t1" }),
    msg("r2", "2026-09-16T10:00:00Z", { threadId: "t1", inReplyTo: "r1" }),
    msg("r3", "2026-09-16T11:00:00Z", { threadId: "t1", inReplyTo: "r2" }),
    msg("s1", "2026-09-16T08:00:00Z"),
  ]);
  assert.equal(threads.length, 2);
  const thread = threads.find(t => t.threadId === "t1");
  assert.deepEqual(thread.entries.map(e => [e.message.id, e.depth]), [["r1", 0], ["r2", 1], ["r3", 2]]);
  assert.equal(thread.depth, 2);
  assert.equal(thread.messageCount, 3);
  assert.equal(thread.firstAt, "2026-09-16T09:00:00Z");
  assert.ok(Object.isFrozen(thread) && Object.isFrozen(thread.entries));
  const singleton = threads.find(t => t.threadId === "s1");
  assert.equal(singleton.messageCount, 1);
});
test("threads sort by most recent activity", () => {
  const threads = buildThreads([
    msg("a1", "2026-09-16T08:00:00Z", { threadId: "ta" }),
    msg("b1", "2026-09-16T09:00:00Z", { threadId: "tb" }),
    msg("a2", "2026-09-16T12:00:00Z", { threadId: "ta" }),
  ]);
  assert.deepEqual(threads.map(t => t.threadId), ["ta", "tb"]);
});
test("cycles and dangling references become roots, never throw", () => {
  const threads = buildThreads([
    msg("x1", "2026-09-16T09:00:00Z", { threadId: "tx", inReplyTo: "x2" }),
    msg("x2", "2026-09-16T10:00:00Z", { threadId: "tx", inReplyTo: "x1" }),
    msg("x3", "2026-09-16T11:00:00Z", { threadId: "tx", inReplyTo: "ghost" }),
  ]);
  const thread = threads[0];
  assert.equal(thread.messageCount, 3);
  assert.ok(thread.entries.every(e => e.depth <= 64));
});
test("threadFor finds the containing thread", () => {
  const messages = [msg("a1", "2026-09-16T08:00:00Z", { threadId: "ta" }), msg("b1", "2026-09-16T09:00:00Z")];
  assert.equal(threadFor(messages, "a1").threadId, "ta");
  assert.equal(threadFor(messages, "b1").threadId, "b1");
  assert.equal(threadFor(messages, "nope"), null);
  throwsCode(() => threadFor(messages, ""), "invalid_thread_input");
});
test("malformed inputs are refused", () => {
  throwsCode(() => buildThreads(null), "invalid_thread_input");
  throwsCode(() => buildThreads([{ id: "m1" }]), "invalid_thread_input");
  throwsCode(() => buildThreads([{ id: "m1", occurredAt: "junk" }]), "invalid_thread_input");
  throwsCode(() => buildThreads([{ id: "m1", occurredAt: "2026-09-16T09:00:00Z", inReplyTo: 7 }]), "invalid_thread_input");
});
