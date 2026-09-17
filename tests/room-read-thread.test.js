// B003: room.read-thread tool contract. Pure envelope tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { readThread, TOOL_DEFINITION, ReadThreadError } from "../server/room-read-thread.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ReadThreadError && error.code === code);
const threads = () => new Map([["t-1", { threadId: "t-1", messages: [
  { id: "m-1", depth: 0, from: "alice", subject: "Hello", body: "Hi there", at: "2026-09-01" },
  { id: "m-2", depth: 1, from: "bob", body: "Hey Alice, welcome!", at: "2026-09-02" },
  { id: "m-3", depth: 2, from: "alice", body: "Thanks!", at: "2026-09-03" },
] }]]);

test("readThread returns depth-capped messages with a participant summary", () => {
  const result = readThread({ threadId: "t-1" }, threads());
  assert.equal(result.threadId, "t-1");
  assert.equal(result.messageCount, 3);
  assert.deepEqual(result.participants, ["alice", "bob"]);
  assert.deepEqual(result.messages.map(m => m.id), ["m-1", "m-2", "m-3"]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.messages));
  const shallow = readThread({ threadId: "t-1", maxDepth: 1 }, threads());
  assert.deepEqual(shallow.messages.map(m => m.id), ["m-1", "m-2"]);
  const limited = readThread({ threadId: "t-1", limit: 2 }, threads());
  assert.equal(limited.returned, 2);
  assert.equal(limited.messageCount, 3);
});
test("missing threads and malformed calls are refused", () => {
  throwsCode(() => readThread({ threadId: "zzz" }, threads()), "thread_not_found");
  throwsCode(() => readThread({ threadId: "" }, threads()), "invalid_read_call");
  throwsCode(() => readThread({ threadId: "t-1", maxDepth: 99 }, threads()), "invalid_read_call");
  throwsCode(() => readThread({ threadId: "t-1" }, null), "invalid_read_call");
  assert.equal(TOOL_DEFINITION.name, "room.read-thread");
});
