import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { requestApproval, takeApproval } from "../machine/lib/approvals.mjs";

// The Mac asks the owner for approval by posting "approve <code> to let …"
// and then polls the room until the owner replies "approve <code>". The reply
// can only come after the request, so each poll must read only events after
// the request (and after what the last poll already read), never the whole
// room history from event 1.

async function serve(t, { seed = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-machine-approval-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  // Seeding history is not live chat: skip the per-member chat flood guard.
  store.roomFlood = { consume() {} };
  for (let i = 0; i < seed; i += 1) {
    const id = randomUUID();
    store.command(ownerKey, "commons", { id, type: "message.posted", data: { messageId: id, body: `history ${i}` } });
  }
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const home = mkdtempSync(join(tmpdir(), "room-machine-approval-home-"));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  return { origin, ownerKey, home };
}

async function say(origin, token, body) {
  const id = randomUUID();
  const response = await fetch(`${origin}/api/rooms/commons/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, authorization: `Bearer ${token}` },
    body: JSON.stringify({ id, type: "message.posted", data: { messageId: id, body } }),
  });
  assert.equal(response.status, 201);
}

// Count the room-event page reads takeApproval makes.
function countEventReads(t) {
  const realFetch = globalThis.fetch;
  const counter = { reads: 0 };
  globalThis.fetch = (url, init) => {
    if (String(url).includes("/events?")) counter.reads += 1;
    return realFetch(url, init);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return counter;
}

test("an approval poll reads only events after the request, not the room's whole history", async t => {
  const { origin, ownerKey, home } = await serve(t, { seed: 450 });
  const requested = await requestApproval({ home, origin, roomId: "commons", secret: ownerKey, ownerMemberId: "owner", className: "shell.desk", detail: "desk shell" });
  assert.equal(requested.ok, true);
  const counter = countEventReads(t);
  const first = await takeApproval({ home, origin, roomId: "commons", secret: ownerKey, code: requested.code });
  assert.equal(first.reason, "approval_required");
  assert.equal(counter.reads, 1, "the first poll should read one page, starting at the request");
  counter.reads = 0;
  await say(origin, ownerKey, "unrelated chatter");
  const second = await takeApproval({ home, origin, roomId: "commons", secret: ownerKey, code: requested.code });
  assert.equal(second.reason, "approval_required");
  assert.equal(counter.reads, 1, "a later poll resumes where the last one stopped");
  await say(origin, ownerKey, `approve ${requested.code}`);
  const taken = await takeApproval({ home, origin, roomId: "commons", secret: ownerKey, code: requested.code });
  assert.equal(taken.ok, true);
  const again = await takeApproval({ home, origin, roomId: "commons", secret: ownerKey, code: requested.code });
  assert.equal(again.reason, "approval_denied");
});

// A room with more than 10,000 events, served by a minimal fake of the two
// routes the approval code uses (seeding 10,000 events through the real
// store takes minutes). Same response shapes as server/http.mjs:
// POST /commands -> { sequence, event }, GET /events -> { events, next }.
async function bigRoom(t, size) {
  const events = [];
  const push = (actorId, body) => {
    const sequence = events.length + 1;
    events.push({ sequence, event: { id: randomUUID(), type: "message.posted", actorId, data: { body } } });
    return sequence;
  };
  for (let i = 0; i < size; i += 1) push("someone", `history ${i}`);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const actor = req.headers.authorization === "Bearer owner-key" ? "owner" : "machine";
    if (req.method === "POST" && url.pathname === "/api/rooms/commons/commands") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const sequence = push(actor, JSON.parse(raw).data.body);
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({ sequence, event: events[sequence - 1].event, duplicate: false }));
    }
    if (req.method === "GET" && url.pathname === "/api/rooms/commons/events") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 100));
      const page = events.filter(entry => entry.sequence > after).slice(0, limit);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ events: page, next: page.length ? page[page.length - 1].sequence : after }));
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(join(tmpdir(), "room-machine-approval-home-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, home };
}

test("the owner's approval is found in a room with more than 10,000 events", async t => {
  const { origin, home } = await bigRoom(t, 10_050);
  const requested = await requestApproval({ home, origin, roomId: "commons", secret: "machine-key", ownerMemberId: "owner", className: "credential.use", detail: "use a saved login" });
  assert.equal(requested.ok, true);
  await say(origin, "owner-key", `approve ${requested.code}`);
  const taken = await takeApproval({ home, origin, roomId: "commons", secret: "machine-key", code: requested.code });
  assert.deepEqual(taken, { ok: true });
});

test("the request records the room position it was posted at", async t => {
  const { origin, ownerKey, home } = await serve(t, { seed: 3 });
  const requested = await requestApproval({ home, origin, roomId: "commons", secret: ownerKey, ownerMemberId: "owner", className: "shell.desk", detail: "desk shell" });
  const rows = JSON.parse(readFileSync(join(home, "approvals.json"), "utf8"));
  assert.ok(Number.isSafeInteger(rows[requested.code].after) && rows[requested.code].after > 0, "the request records the room position it was posted at");
});

test("a pending approval saved before this change (no cursor) still works", async t => {
  const { origin, ownerKey, home } = await serve(t, { seed: 5 });
  writeFileSync(join(home, "approvals.json"), JSON.stringify({ legacy: { className: "shell.desk", ownerMemberId: "owner", expiresAt: Date.now() + 60_000, createdAt: Date.now(), used: false } }));
  await say(origin, ownerKey, "approve legacy");
  const taken = await takeApproval({ home, origin, roomId: "commons", secret: ownerKey, code: "legacy" });
  assert.deepEqual(taken, { ok: true });
});
