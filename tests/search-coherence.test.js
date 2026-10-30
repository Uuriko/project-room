/**
 * search-coherence.test.js — SEARCH-COHERENCE (UT2 conversion, Option A).
 *
 * Two contracts, pinned per surface:
 *  1. ORDER: room search presents hits NEWEST-FIRST on every surface —
 *     REST `Store.search` and the web client's `searchMessages` return the
 *     same corpus in the same order, so "the first result" is a stable
 *     citation again. (Before this build the server returned the exact
 *     reverse of the client.)
 *  2. PARAMETER HONESTY: on the public list/search surfaces a parameter is
 *     honoured or honestly refused — 422 naming the accepted set, in the
 *     shape offers/public-work already used. A silently ignored ?q= (the
 *     UT2 finding: byte-identical unfiltered 200s) is the defect.
 * Also pins the step-0 re-probe finding that work-item TITLES are indexed
 * (title-only needle hits on REST and store search) so it cannot regress.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { searchMessages } from "../src/conversation.js";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-search-coherence-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, token) => fetch(origin + path, { headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const post = body => store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body } }).event.data.messageId;
  const propose = (title, definitionOfDone = "done when done") => store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.WORK_PROPOSED, data: { workItemId: randomUUID(), title, definitionOfDone, accountableMemberId: "owner", verifierMemberId: "owner", mode: "write" } }).event.data.workItemId;
  return { store, ownerKey, get, post, propose };
}

test("cross-surface order: REST search and the web client return the same corpus newest-first", async t => {
  const { store, ownerKey, get, post } = await serve(t);
  const ids = [];
  for (let i = 1; i <= 4; i++) ids.push(post(`zebra corpus message ${i}`));
  post("unrelated chatter");

  const res = await get("/api/rooms/commons/search?q=zebra&kind=messages", ownerKey);
  assert.equal(res.status, 200);
  const rest = await res.json();
  assert.deepEqual(rest.messages.map(m => m.id), [...ids].reverse(), "REST presents newest first");

  const snap = store.snapshot(ownerKey, "commons");
  const client = searchMessages(snap.state ?? snap, "zebra", 50, { viewer: null });
  assert.deepEqual(client.messages.map(m => m.id), rest.messages.map(m => m.id),
    "the client and the API cite the same first result");
});

test("work hits are newest-first, and a title-only needle is found (step-0 pin)", async t => {
  const { ownerKey, get, propose } = await serve(t);
  const older = propose("heron older task");
  const titleOnly = propose("quixotic title only", "plain done text");
  const newer = propose("heron newer task");

  const res = await get("/api/rooms/commons/search?q=heron&kind=work", ownerKey);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.workItems.map(w => w.id), [newer, older], "work presented newest first");

  const titleRes = await get("/api/rooms/commons/search?q=quixotic&kind=work", ownerKey);
  const titleBody = await titleRes.json();
  assert.deepEqual(titleBody.workItems.map(w => w.id), [titleOnly],
    "a needle that appears only in a work item's title finds it");
});

test("parameter honesty: receipts list (API + HTML) refuses unknown params, honours its filters", async t => {
  const { get } = await serve(t);
  for (const path of [
    "/api/public/receipts?q=zebra", "/api/public/receipts?search=zebra", "/api/public/receipts?after=xyz",
    "/api/public/receipts?title=zebra", "/api/public/receipts?limit=5&limit=6",
    "/receipts?q=zebra", "/receipts?worker=zebra",
  ]) {
    const res = await get(path);
    assert.equal(res.status, 422, `${path} -> 422, not a silent ignore`);
    const body = await res.json();
    assert.equal(body.error?.code ?? body.code, "invalid_receipt_query");
    assert.match(body.error?.message ?? body.message, /Only room, agent, cursor and limit accepted/);
  }
  for (const path of ["/api/public/receipts", "/api/public/receipts?room=commons", "/api/public/receipts?agent=nobody", "/api/public/receipts?limit=5", "/receipts"]) {
    const res = await get(path);
    assert.equal(res.status, 200, `${path} stays 200`);
    await res.text();
  }
  // The HTML wall exposes the honoured filters as a form.
  const wall = await (await get("/receipts")).text();
  assert.match(wall, /<form method="get" action="\/receipts">/);
  assert.match(wall, /name="room"/);
  assert.match(wall, /name="agent"/);
  // A receipt detail accepts only verify.
  const detail = await get("/receipts/pwr_0000000000000000?q=zebra");
  assert.equal(detail.status, 422);
  const missing = await get("/receipts/pwr_0000000000000000?verify=1");
  assert.equal(missing.status, 404, "verify is accepted; the unknown receipt is the 404");
});

test("parameter honesty: rooms directory, agent directory, agents page, opportunities", async t => {
  const { get } = await serve(t);
  const cases = [
    ["/api/public/rooms/directory?q=zebra", "invalid_directory", /Only after and limit accepted/],
    ["/api/public/rooms/directory?search=zebra", "invalid_directory", /Only after and limit accepted/],
    ["/api/public/rooms/directory?limit=5&limit=6", "invalid_directory", /Only after and limit accepted/],
    ["/api/agents/directory?search=zebra", "invalid_agent_directory", /Only q and capability accepted/],
    ["/api/agents/directory?query=zebra", "invalid_agent_directory", /Only q and capability accepted/],
    ["/api/agents/directory?filter=zebra", "invalid_agent_directory", /Only q and capability accepted/],
    ["/api/agent-directory?search=zebra", "invalid_agent_directory", /Only q and capability accepted/],
    ["/agents?q=zebra", "invalid_agent_directory", /Only ref and cursor accepted/],
    ["/agents?search=zebra", "invalid_agent_directory", /Only ref and cursor accepted/],
    ["/api/opportunities.json?q=zebra", "invalid_opportunities", /Only room, limit and since accepted/],
  ];
  for (const [path, code, message] of cases) {
    const res = await get(path);
    assert.equal(res.status, 422, `${path} -> 422, not a silent ignore`);
    const body = await res.json();
    assert.equal(body.error?.code ?? body.code, code, path);
    assert.match(body.error?.message ?? body.message, message, path);
  }
  for (const path of [
    "/api/public/rooms/directory", "/api/public/rooms/directory?limit=5",
    "/api/agents/directory", "/api/agents/directory?q=zebra", "/api/agents/directory?capability=code",
    "/api/agent-directory?q=zebra",
    "/agents", "/agents?ref=tester",
    "/api/opportunities.json", "/api/opportunities.json?limit=5",
  ]) {
    const res = await get(path);
    assert.equal(res.status, 200, `${path} stays 200`);
    await res.text();
  }
});

test("parameter honesty controls: offers and public-work tasks still refuse as before", async t => {
  const { get } = await serve(t);
  const offers = await get("/api/project-offers?q=zebra");
  assert.equal(offers.status, 422);
  assert.equal((await offers.json()).error?.code, "invalid_project_offer");
  const tasks = await get("/api/public-work/tasks?q=zebra");
  assert.equal(tasks.status, 422);
  assert.equal((await tasks.json()).error?.code, "invalid_public_work");
});
