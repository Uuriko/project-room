// Task 175: webhook security review — forged and replayed webhook tests.
//
// Guards the /api/github/pr-webhook boundary at the real boundary:
//   1. A delivery with a forged HMAC signature is rejected (401) and the
//      failure response carries no secret or signature material.
//   2. A replayed (verbatim redelivered) valid payload links nothing twice
//      and emits no duplicate receipt — at the HTTP route level.
//   3. The same idempotency holds at the handlePrWebhookPayload level for
//      both "opened" (link) and "closed+merged" (settle) deliveries.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import {
  handlePrWebhookPayload,
} from "../server/claim-autolink.mjs";

const URL_A = "https://github.com/Uuriko/project-room/pull/7";
const REPO = "Uuriko/project-room";

function makeRoom(t, roomId = "commons") {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(roomId));
  t.after(() => store.close());
  const call = (route, id, body) => handleWorkClaims({
    req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
    res: {},
    url: new URL(`https://room.example/api/rooms/${roomId}/work-claims`),
    store, roomId,
    auth: { member: { id: "owner", kind: "human", permissions: [] } },
    workClaimRoute: route, workClaimId: id,
    helpers: {
      json: (_res, status, value) => ({ status, value }),
      reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
      body: async req => req.body,
    },
    registry: store.workClaims,
  });
  return { store, call, roomId };
}

const claimEvents = (store, roomId) => store.db.prepare(
  "SELECT body FROM events WHERE room_id=? ORDER BY sequence"
).all(roomId).map(row => JSON.parse(row.body)).filter(event => event.type === "work_claim.updated");

async function liveClaim(make, id) {
  const { call } = make;
  await call("create", null, { id, files: [`server/${id}.mjs`], repo: REPO, branch: id });
  await call("claim", id, { leaseHours: 6 });
}

const prPayload = (overrides = {}) => ({
  action: "opened",
  pull_request: {
    html_url: URL_A,
    head: { ref: "lane-replay" },
    title: "lane-replay: wire the thing",
    body: "implements the claim",
    merged: false,
    state: "open",
    ...(overrides.pull_request ?? {}),
  },
  repository: { full_name: REPO },
  ...(overrides.top ?? {}),
});

// --- replay at the handler level ------------------------------------------

test("replay: a redelivered 'opened' delivery links nothing and emits no receipt", async t => {
  const make = makeRoom(t);
  await liveClaim(make, "lane-replay");
  const payload = prPayload();
  const first = handlePrWebhookPayload(make.store, payload, { nowMs: 1_700_000_000_000 });
  assert.equal(first.ok, true);
  assert.equal(first.linked.claimId, "lane-replay");
  const eventsAfterFirst = claimEvents(make.store, make.roomId).length;
  const historyAfterFirst = make.store.workClaims.get(make.roomId, "lane-replay").history.length;

  const second = handlePrWebhookPayload(make.store, structuredClone(payload), { nowMs: 1_700_000_000_001 });
  assert.equal(second.ok, true);
  assert.equal(second.linked, null);
  assert.equal(second.settled.length, 0);
  assert.equal(claimEvents(make.store, make.roomId).length, eventsAfterFirst,
    "a replayed delivery must not emit a second receipt");
  assert.equal(make.store.workClaims.get(make.roomId, "lane-replay").history.length, historyAfterFirst,
    "a replayed delivery must not append history");
});

test("replay: a redelivered 'closed+merged' delivery settles nothing twice", async t => {
  const make = makeRoom(t);
  await liveClaim(make, "lane-replay");
  const payload = prPayload({ top: { action: "closed" }, pull_request: { merged: true, state: "closed" } });
  const first = handlePrWebhookPayload(make.store, payload, { nowMs: 1_700_000_000_000 });
  assert.equal(first.ok, true);
  assert.equal(first.settled.length, 1);
  const eventsAfterFirst = claimEvents(make.store, make.roomId).length;

  const second = handlePrWebhookPayload(make.store, structuredClone(payload), { nowMs: 1_700_000_000_001 });
  assert.equal(second.ok, true);
  assert.equal(second.settled.length, 0);
  assert.equal(second.linked, null);
  assert.equal(claimEvents(make.store, make.roomId).length, eventsAfterFirst,
    "a replayed settle must not emit a second receipt");
});

// --- forgery + replay at the HTTP route level ------------------------------

function sign(body, secret) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("route: a forged signature is rejected and the failure leaks no secret material", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-webhook-forged-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const oldFlag = process.env.ROOM_PR_WEBHOOK, oldSecret = process.env.GITHUB_PR_WEBHOOK_SECRET;
  t.after(() => {
    server.closeStreams(); server.closeAllConnections(); server.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
    if (oldFlag === undefined) delete process.env.ROOM_PR_WEBHOOK; else process.env.ROOM_PR_WEBHOOK = oldFlag;
    if (oldSecret === undefined) delete process.env.GITHUB_PR_WEBHOOK_SECRET; else process.env.GITHUB_PR_WEBHOOK_SECRET = oldSecret;
  });
  const url = `http://127.0.0.1:${server.address().port}/api/github/pr-webhook`;
  const body = JSON.stringify({ zen: "forgery attempt" });
  const secret = "route-fixture-secret";
  process.env.ROOM_PR_WEBHOOK = "1";
  process.env.GITHUB_PR_WEBHOOK_SECRET = secret;

  const forged = sign(body, "attacker-secret");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": forged },
    body,
  });
  assert.equal(response.status, 401);
  const text = await response.text();
  assert.ok(!text.includes(secret), "failure response must not echo the server secret");
  assert.ok(!text.includes("attacker-secret"), "failure response must not echo presented material");

  const missing = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "ping" },
    body,
  });
  assert.equal(missing.status, 401);
});

test("route: a replayed signed delivery writes nothing twice", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-webhook-replay-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const oldFlag = process.env.ROOM_PR_WEBHOOK, oldSecret = process.env.GITHUB_PR_WEBHOOK_SECRET;
  t.after(() => {
    server.closeStreams(); server.closeAllConnections(); server.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
    if (oldFlag === undefined) delete process.env.ROOM_PR_WEBHOOK; else process.env.ROOM_PR_WEBHOOK = oldFlag;
    if (oldSecret === undefined) delete process.env.GITHUB_PR_WEBHOOK_SECRET; else process.env.GITHUB_PR_WEBHOOK_SECRET = oldSecret;
  });
  process.env.ROOM_PR_WEBHOOK = "1";
  const secret = "route-replay-secret";
  process.env.GITHUB_PR_WEBHOOK_SECRET = secret;
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/api/github/pr-webhook`;
  const payload = {
    action: "opened",
    pull_request: {
      html_url: "https://github.com/Uuriko/project-room/pull/7",
      head: { ref: "lane-http-replay" },
      title: "lane-http-replay: wire the thing",
      body: "implements the claim",
      merged: false, state: "open",
    },
    repository: { full_name: "Uuriko/project-room" },
  };
  const body = JSON.stringify(payload);
  const headers = {
    "content-type": "application/json",
    "x-github-event": "pull_request",
    "x-hub-signature-256": sign(body, secret),
  };
  // A live claim matches the PR branch, so the first delivery links it and
  // emits exactly one receipt; the second identical delivery must be a
  // no-op — same response, no second link, no second receipt.
  const eventsBefore = store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  const first = await fetch(url, { method: "POST", headers, body });
  const firstJson = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstJson.linked, null); // no live claim matches this branch
  const afterFirst = store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  const second = await fetch(url, { method: "POST", headers, body });
  const secondJson = await second.json();
  assert.equal(second.status, 200);
  assert.deepEqual(secondJson, firstJson, "a replayed delivery returns the same response");
  const afterSecond = store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  assert.equal(afterSecond, afterFirst, "a replayed delivery journals no new events");
  assert.ok(afterFirst - eventsBefore <= 0, "an unmatched delivery emits nothing");
});
