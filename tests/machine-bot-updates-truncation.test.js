import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineBot } from "../machine/bot/loop.mjs";
import { createRoomApi } from "../machine/bot/room-api.mjs";
import { sourcesIncomplete } from "../machine/bot/queue.mjs";

// Issue #2871: room-api updates() stopped after 5 pages x 100 items even
// when the server reported hasMore, and returned the partial list as if it
// were complete. In loop.mjs readQueue(), a wake pointing past item 500
// then found no queue match and no incomplete sources, so it was acked as
// "handled" and the work was never executed. A capped (or otherwise
// truncated) listing must be flagged incomplete so such a wake falls back
// instead of being acked.

const ORIGIN = "http://room.test";
const FALSE_FLAGS = { mentions: false, peerDms: false, claims: false, invites: false, accessRequests: false, wakes: false, rooms: false };

function pageBody(page, { total = 600, hasMore = true, cursor } = {}) {
  const items = Array.from({ length: 100 }, (_, i) => {
    const n = page * 100 + i;
    return { id: `update-${n}`, sourceRef: { messageId: `msg-${n}` } };
  });
  return {
    items: items.slice(0, Math.max(0, Math.min(100, total - page * 100))),
    hasMore,
    cursor: cursor !== undefined ? cursor : `cursor-${page + 1}`,
    incompleteSources: { ...FALSE_FLAGS },
  };
}

// Stub global fetch so createRoomApi paginates a synthetic updates list.
// handler(pageIndex, url) -> body object for that page.
function stubUpdatesFetch(t, handler) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(String(url));
    requests.push(parsed);
    const cursor = parsed.searchParams.get("cursor");
    const page = cursor ? Number(cursor.replace("cursor-", "")) : 0;
    return new Response(JSON.stringify(handler(page, parsed)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return requests;
}

test("updates() flags a listing truncated at the 500-item page cap as incomplete", async t => {
  const requests = stubUpdatesFetch(t, page => pageBody(page));
  const api = createRoomApi({ origin: ORIGIN, secret: "test-secret" });
  const listed = await api.updates("commons");
  assert.equal(listed.ok, true);
  assert.equal(requests.length, 5, "the page cap still bounds the fetch");
  assert.equal(listed.value.items.length, 500);
  assert.equal(
    listed.value.incompleteSources?.truncated, true,
    `a hasMore listing cut off by the cap must be flagged truncated, got ${JSON.stringify(listed.value.incompleteSources)}`,
  );
  assert.equal(
    sourcesIncomplete(listed.value.incompleteSources), true,
    "readQueue must treat a truncated listing as incomplete, not complete",
  );
});

test("updates() flags a hasMore listing with no usable cursor as truncated", async t => {
  stubUpdatesFetch(t, page => pageBody(page, { hasMore: true, cursor: null }));
  const api = createRoomApi({ origin: ORIGIN, secret: "test-secret" });
  const listed = await api.updates("commons");
  assert.equal(listed.ok, true);
  assert.equal(listed.value.items.length, 100);
  assert.equal(listed.value.incompleteSources?.truncated, true);
  assert.equal(sourcesIncomplete(listed.value.incompleteSources), true);
});

test("a wake past the truncation cap is not acked as handled", async t => {
  stubUpdatesFetch(t, page => pageBody(page));
  const home = mkdtempSync(join(tmpdir(), "room-bot-truncation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bot = new MachineBot({ home, env: {} });
  const api = createRoomApi({ origin: ORIGIN, secret: "test-secret" });
  bot.api = {
    orient: async () => ({ ok: true, status: 200, value: { you: { member: { id: "bot-member" } }, workItems: [], claims: [] } }),
    updates: roomId => api.updates(roomId),
  };
  // msg-550 exists on the server (item 551 of 600) but is beyond the cap.
  const queued = await bot.readQueue("commons", { roomId: "commons", signalId: "wake-1", messageId: "msg-550" });
  assert.deepEqual(
    queued, { ok: true, fallback: true },
    `a wake whose item may lie past the cap must fall back (unacked), not be reported handled; got ${JSON.stringify(queued)}`,
  );
});

test("a complete listing is not flagged, and an absent wake is still handled", async t => {
  stubUpdatesFetch(t, page => pageBody(page, { total: 3, hasMore: false, cursor: null }));
  const home = mkdtempSync(join(tmpdir(), "room-bot-complete-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const api = createRoomApi({ origin: ORIGIN, secret: "test-secret" });
  const listed = await api.updates("commons");
  assert.equal(listed.ok, true);
  assert.equal(listed.value.items.length, 3);
  assert.notEqual(listed.value.incompleteSources?.truncated, true);
  assert.equal(sourcesIncomplete(listed.value.incompleteSources), false);

  const bot = new MachineBot({ home, env: {} });
  bot.api = {
    orient: async () => ({ ok: true, status: 200, value: { you: { member: { id: "bot-member" } }, workItems: [], claims: [] } }),
    updates: roomId => api.updates(roomId),
  };
  const queued = await bot.readQueue("commons", { roomId: "commons", signalId: "wake-2", messageId: "msg-absent" });
  assert.deepEqual(queued, { ok: false, reason: "handled" });
});
