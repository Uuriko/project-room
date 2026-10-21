import test from "node:test";
import assert from "node:assert/strict";
import { createClipboard } from "../src/clipboard.js";

test("slow clipboard retains exclusive ownership until the actual write settles", async () => {
  let finish;
  const writes = [], states = [];
  const clipboard = createClipboard({ delay: 5, write: text => {
    writes.push(text); return new Promise(resolve => { finish = resolve; });
  } });
  const unsubscribe = clipboard.subscribe(() => states.push([clipboard.busy, clipboard.slow]));
  assert.equal(await clipboard.copy("old"), "pending");
  assert.equal(await clipboard.copy("new"), "busy");
  assert.deepEqual(writes, ["old"]);
  finish(); await Promise.resolve();
  assert.deepEqual(states, [[true, false], [true, true], [false, false]]);
  unsubscribe();
  const next = clipboard.copy("new"); finish();
  assert.equal(await next, "copied");
  assert.deepEqual(writes, ["old", "new"]);
});

test("clipboard rejects concurrent work immediately and reports genuine rejection", async () => {
  let reject;
  const clipboard = createClipboard({ write: () => new Promise((_, fail) => { reject = fail; }) });
  const pending = clipboard.copy("one");
  assert.equal(await clipboard.copy("two"), "busy");
  reject(new Error("denied"));
  assert.equal(await pending, "failed");
  assert.equal(clipboard.busy, false);
});

test("synchronous clipboard refusal releases ownership", async () => {
  const clipboard = createClipboard({ write: () => { throw new Error("unavailable"); } });
  assert.equal(await clipboard.copy("text"), "failed");
  assert.equal(clipboard.busy, false);
});

test("late rejection releases the lock without changing the pending outcome", async () => {
  let reject;
  const clipboard = createClipboard({ delay: 5, write: () => new Promise((_, fail) => { reject = fail; }) });
  const result = clipboard.copy("text");
  assert.equal(await result, "pending");
  reject(new Error("late denial")); await Promise.resolve();
  assert.equal(clipboard.busy, false);
  assert.equal(await result, "pending");
});
