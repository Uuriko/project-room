// paginateRoomMessages backward-window tiling: every 100-event boundary must
// deliver its seam message exactly once (land-johnstab-1610-gap).
import test from "node:test";
import assert from "node:assert/strict";
import { paginateRoomMessages } from "../client/room-agent.mjs";

function messageEvent(sequence) {
  return { sequence, event: { type: "message.posted", id: `e${sequence}` } };
}

// Mimics GET /events?after=<cursor>&limit=<pageLimit>: after-exclusive,
// up to pageLimit events.
function fetchPage(events) {
  return async (cursor, pageLimit) => ({
    events: events.filter(e => e.sequence > cursor && e.sequence <= cursor + pageLimit),
  });
}

test("latest:true returns every message across 100-event boundaries with no seam skips", async () => {
  const events = Array.from({ length: 250 }, (_, i) => messageEvent(i + 1));
  const { messages } = await paginateRoomMessages(fetchPage(events), {
    after: 0, limit: 250, latest: true, end: 251,
  });
  assert.equal(messages.length, 250);
  assert.deepEqual(messages.map(m => m.sequence), events.map(e => e.sequence));
});

test("latest:true keeps the end bound exclusive while tiling seams inclusively", async () => {
  const events = Array.from({ length: 210 }, (_, i) => messageEvent(i + 1));
  const { messages } = await paginateRoomMessages(fetchPage(events), {
    after: 0, limit: 210, latest: true, end: 201,
  });
  // end is exclusive: seq 201..210 must not appear; everything below must.
  assert.deepEqual(messages.map(m => m.sequence),
    Array.from({ length: 200 }, (_, i) => i + 1));
});

test("latest:true second page across a seam continues with no gap or duplicate", async () => {
  const events = Array.from({ length: 250 }, (_, i) => messageEvent(i + 1));
  const first = await paginateRoomMessages(fetchPage(events), {
    after: 0, limit: 100, latest: true, end: 251,
  });
  assert.deepEqual(first.messages.map(m => m.sequence),
    Array.from({ length: 100 }, (_, i) => i + 151));
  const second = await paginateRoomMessages(fetchPage(events), {
    after: 0, limit: 150, latest: true, end: first.next,
  });
  assert.deepEqual(second.messages.map(m => m.sequence),
    Array.from({ length: 150 }, (_, i) => i + 1));
});

test("latest:true with a non-message event mix still tiles seams exactly once", async () => {
  const events = [];
  for (let i = 1; i <= 220; i += 1) {
    events.push(i % 3 === 0
      ? { sequence: i, event: { type: "presence", id: `p${i}` } }
      : messageEvent(i));
  }
  const want = events.filter(e => e.event.type === "message.posted").map(e => e.sequence);
  const { messages } = await paginateRoomMessages(fetchPage(events), {
    after: 0, limit: want.length, latest: true, end: 221,
  });
  assert.deepEqual(messages.map(m => m.sequence), want);
});

test('latest snapshot fails explicitly when bounded sparse backward scan cannot fill it', async () => {
  let calls = 0;
  const read = async (cursor, pageLimit) => {
    calls += 1;
    const next = Math.min(10000, cursor + Math.min(pageLimit, 10));
    return { events: Array.from({ length: next - cursor }, (_, i) => {
      const sequence = cursor + i + 1;
      return { sequence, event: { type: sequence % 500 === 0 ? 'message.posted' : 'work.updated' } };
    }), next, hasMore: next < 10000 };
  };
  await assert.rejects(paginateRoomMessages(read, { after: 0, end: 10001, limit: 5, latest: true }), e => e.code === 'message_window_unavailable');
  assert.equal(calls, 100);
});

test('latest without a head fails explicitly when forward scan does not reach the end', async () => {
  const read = async (cursor, pageLimit) => {
    const next = Math.min(10100, cursor + pageLimit);
    return { events: [{ sequence: next, event: { type: 'message.posted' } }], next, hasMore: next < 10100 };
  };
  await assert.rejects(paginateRoomMessages(read, { after: 0, limit: 5, latest: true }), e => e.code === 'message_window_unavailable');
});
