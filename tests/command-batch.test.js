// #1905: concurrent write throughput. Fail-first tests for the group-commit
// slice: store.commandBatch() batches N commands into fewer sqlite
// transactions, the HTTP command queue pipelines concurrent POSTs through
// it, and one bad command never takes down its batch.
//
// The throughput regression signal is structural, not timing-based: the
// number of sqlite COMMITs for N commands must be < N (group commit
// engaged). Wall-clock numbers live in scripts/bench-1905.mjs and the PR
// body, not in assertions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { createCommandQueue } from "../server/command-queue.mjs";

const ROOM = "commons";

function openStore({ members = 4 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cmd-batch-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const keys = [];
  for (let i = 0; i < members; i++) {
    const memberId = `cb-${i}`;
    store.command(ownerKey, ROOM, { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work", "complete_work"] } });
    keys.push(store.issueAccessKey(ROOM, memberId));
  }
  // Flood budget: 30-post burst per (room, member); keep every member under it.
  store.roomFlood.consume = () => {};
  return { directory, store, keys, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function countCommits(store) {
  let commits = 0;
  const origExec = store.db.exec.bind(store.db);
  store.db.exec = sql => {
    if (typeof sql === "string" && /^\s*COMMIT\b/i.test(sql)) commits++;
    return origExec(sql);
  };
  return { get: () => commits, reset: () => { commits = 0; } };
}

const post = (key, body) => ({ token: key,
  command: { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body } },
  expectedSessionBinding: null });

test("commandBatch groups N commands into fewer sqlite transactions", () => {
  const { store, keys, close } = openStore();
  try {
    const counter = countCommits(store);
    const before = store.room(ROOM).sequence;
    const N = 10;
    counter.reset();
    const results = store.commandBatch(ROOM, Array.from({ length: N }, (_, i) => post(keys[0], `batch ${i}`)));
    assert.equal(results.length, N);
    for (const r of results) assert.equal(r.ok, true, JSON.stringify(r.error ?? null));
    const sequences = results.map(r => r.result.sequence);
    assert.deepEqual(sequences, sequences.map((_, i) => before + 1 + i), "sequences are contiguous in input order");
    assert.ok(counter.get() < N, `expected group commit: ${counter.get()} COMMITs for ${N} commands`);
    assert.equal(store.room(ROOM).sequence, before + N);
  } finally { close(); }
});

test("commandBatch isolates a failing command: the rest of the batch commits", () => {
  const { store, keys, close } = openStore();
  try {
    const before = store.room(ROOM).sequence;
    const items = [
      post(keys[0], "good one"),
      // Reaction on a message that does not exist: the reducer refuses it.
      { token: keys[0], command: { id: randomUUID(), type: T.MESSAGE_REACTION_SET,
        data: { messageId: "no-such-message", reaction: "like", active: true } }, expectedSessionBinding: null },
      post(keys[0], "good two"),
    ];
    const results = store.commandBatch(ROOM, items);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false, "the bad command reports its own failure");
    assert.ok(results[1].error && results[1].error.status >= 400 && results[1].error.status < 500,
      `bad command keeps its 4xx, got ${results[1].error?.status}`);
    assert.equal(results[2].ok, true);
    // Exactly the two good commands persisted; sequences stay contiguous.
    assert.equal(store.room(ROOM).sequence, before + 2);
    assert.deepEqual([results[0].result.sequence, results[2].result.sequence], [before + 1, before + 2]);
  } finally { close(); }
});

test("commandBatch honors idempotency inside one batch", () => {
  const { store, keys, close } = openStore();
  try {
    const id = randomUUID();
    const messageId = randomUUID();
    const item = () => ({ token: keys[0],
      command: { id, type: T.MESSAGE_POSTED, data: { messageId, body: "retry me" } },
      expectedSessionBinding: null });
    const before = store.room(ROOM).sequence;
    const [first, second] = store.commandBatch(ROOM, [item(), item()]);
    assert.equal(first.ok, true);
    assert.equal(first.result.duplicate, false);
    assert.equal(second.ok, true);
    assert.equal(second.result.duplicate, true, "same command id in the batch replays as a duplicate");
    assert.equal(second.result.sequence, first.result.sequence);
    assert.equal(store.room(ROOM).sequence, before + 1, "the duplicate persisted nothing");
  } finally { close(); }
});

test("commandBatch on an unknown room fails every item, not the process", () => {
  const { store, keys, close } = openStore();
  try {
    const results = store.commandBatch("no-such-room", [post(keys[0], "x"), post(keys[0], "y")]);
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(r.ok, false);
      // authenticate() runs before the room read, so a bogus room surfaces
      // as access_denied — exactly what command() returns for the same call.
      assert.equal(r.error?.code, "access_denied");
    }
    // And the single-command path agrees:
    assert.throws(() => store.command(keys[0], "no-such-room", post(keys[0], "x").command),
      error => error?.code === "access_denied");
  } finally { close(); }
});

test("command queue: concurrent HTTP POSTs batch, keep order, and surface per-command errors", async () => {
  const { store, keys, close } = openStore({ members: 8 });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const counter = countCommits(store);
    const before = store.room(ROOM).sequence;
    const writers = 8, postsPerWriter = 5, total = writers * postsPerWriter;
    counter.reset();
    const wallStart = performance.now();
    const outcomes = await Promise.all(keys.map((key, w) =>
      (async () => {
        const statuses = [];
        for (let i = 0; i < postsPerWriter; i++) {
          const r = await fetch(`${origin}/api/rooms/${ROOM}/commands`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({ id: randomUUID(), type: T.MESSAGE_POSTED,
              data: { messageId: randomUUID(), body: `q ${w}-${i}` } }),
          });
          statuses.push(r.status);
          await r.text();
        }
        return statuses;
      })()));
    const wallMs = performance.now() - wallStart;
    const statuses = outcomes.flat();
    assert.ok(statuses.every(s => s === 201), `all posts 201, got ${statuses.filter(s => s !== 201)}`);
    assert.equal(store.room(ROOM).sequence, before + total, "every post persisted exactly once");
    assert.ok(counter.get() < total, `expected HTTP batching: ${counter.get()} COMMITs for ${total} posts`);
    assert.ok(wallMs < 120000, `no hang/deadlock under concurrency (took ${Math.round(wallMs)}ms)`);
    // A bad command in the stream surfaces as its own 4xx without failing neighbors.
    const bad = await fetch(`${origin}/api/rooms/${ROOM}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys[0]}` },
      body: JSON.stringify({ id: randomUUID(), type: T.MESSAGE_REACTION_SET,
        data: { messageId: "no-such-message", reaction: "like", active: true } }),
    });
    assert.equal(bad.status, 422, `bad command keeps its 422, got ${bad.status}`);
    await bad.text();
    const good = await fetch(`${origin}/api/rooms/${ROOM}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys[0]}` },
      body: JSON.stringify({ id: randomUUID(), type: T.MESSAGE_POSTED,
        data: { messageId: randomUUID(), body: "after the bad one" } }),
    });
    assert.equal(good.status, 201);
    await good.text();
  } finally {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    close();
  }
});

test("command queue backpressure: a full queue refuses with 503, it does not grow unbounded", async () => {
  const { store, keys, close } = openStore();
  try {
    const queue = createCommandQueue({ store, maxDepth: 2 });
    const p1 = queue.enqueue(ROOM, post(keys[0], "a"));
    const p2 = queue.enqueue(ROOM, post(keys[0], "b"));
    const p3 = queue.enqueue(ROOM, post(keys[0], "c"));
    let capped = null;
    try { queue.enqueue(ROOM, post(keys[0], "d")); } catch (error) { capped = error; }
    assert.ok(capped, "the fourth synchronous enqueue hits the depth cap");
    assert.equal(capped.code, "command_queue_full");
    assert.equal(capped.status, 503);
    await Promise.all([p1, p2, p3]);
  } finally { close(); }
});
