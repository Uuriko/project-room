import assert from "node:assert/strict";
import test from "node:test";
import { holdMuseHandoff, museHandoffPolicy } from "../scripts/muse-stream-handoff.mjs";

const connection = { origin: "https://room.example.org", roomId: "build", memberId: "muse" };
const policy = museHandoffPolicy({ ...connection, version: 1, requesters: ["codex"], workItems: ["ready"],
  requests: [], bootstrapAfter: 10, windowSeconds: 10 }, connection);
const request = (id, patch = {}) => ({ id, status: "open", requesterId: "codex", recipientId: "muse",
  workItemId: "ready", openingEventId: "open-" + id, revision: 0, ...patch });
const context = (row, sequence) => ({ roomId: "build", viewerId: "muse", roomCreatedEventId: "room-birth",
  request: row, page: { items: [{ kind: "opened", eventId: row.openingEventId, sequence, message: { body: "private QA details" } }] } });

test("one handoff skips unrelated, acknowledged, closed and old requests and preserves the next ready request", async () => {
  const old = request("old"), closed = request("closed"), seen = request("seen");
  const first = request("first"), second = request("second"), reads = [];
  let scans = 0;
  const client = {
    replyRequests({ cursor }) {
      if (cursor) return { evaluatedThrough: 20, requests: [first], page: { hasMore: false } };
      if (++scans === 1) return { evaluatedThrough: 14, requests: [old, closed, seen,
        request("self", { requesterId: "muse" }), request("other-work", { workItemId: "other" })] };
      return { evaluatedThrough: 20, requests: [second], page: { hasMore: true, nextCursor: "continued" } };
    },
    replyContext(id) {
      reads.push(id);
      return {
        old: context(old, 9), closed: context({ ...closed, status: "answered" }, 12),
        seen: context({ ...seen, acknowledgedAt: "2026-11-18T21:00:00Z" }, 13),
        first: context(first, 15), second: context(second, 17)
      }[id];
    },
    waitForChange(after) {
      assert.equal(after, 14);
      return { changed: true, sequence: 16 };
    }
  };
  let checkpoint = { after: 10, inFlight: null };
  const signal = new AbortController().signal, save = value => { checkpoint = value; };
  const result = await holdMuseHandoff({ client, policy, checkpoint, save, signal });
  assert.equal(result.requestMessageId, "first");
  assert.equal(result.after, 15);
  assert.equal(checkpoint.inFlight.requestMessageId, "first");
  assert.deepEqual(reads, ["old", "closed", "seen", "second", "first"]);
  assert.doesNotMatch(JSON.stringify(result), /private QA/);
});

test("reconnect preserves an unseen pointer and assigns newer work after it is acknowledged", async () => {
  const first = request("first"), second = request("second"), writes = [];
  let done = false;
  const client = {
    replyContext(id) { return id === "first" ? context({ ...first, ...(done ? { progressState: "acknowledged" } : {}) }, 15) : context(second, 17); },
    replyRequests() { return { evaluatedThrough: 17, requests: [second] }; }
  };
  let checkpoint = { after: 15, inFlight: {
    requestMessageId: "first", requesterId: "codex", recipientId: "muse", roomCreatedEventId: "room-birth",
    openingEventId: "open-first", openingSequence: 15, requestRevision: 0
  } };
  const run = () => holdMuseHandoff({ client, policy, checkpoint, signal: new AbortController().signal, save(value) { writes.push(value); checkpoint = value; } });
  assert.equal((await run()).replay, true);
  assert.equal(writes.length, 0);
  done = true;
  const result = await run();
  assert.equal(result.requestMessageId, "second");
  assert.equal(result.replay, false);
  assert.equal(writes[0].inFlight, null);
});

test("empty wait never starts work and clock expiry respects the stop signal", async () => {
  const controller = new AbortController();
  let waited = 0;
  const client = {
    replyRequests() { return { evaluatedThrough: 11, requests: [] }; },
    waitForChange(after) { assert.equal(after, 11); if (++waited === 2) controller.abort(); return { changed: false }; }
  };
  await assert.rejects(holdMuseHandoff({ client, policy, checkpoint: { after: 10, inFlight: null },
    signal: controller.signal, save() {} }), { name: "AbortError" });
  assert.equal(waited, 2);
});
