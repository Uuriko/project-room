// Claim and pull overlap: the agent sees it on the claim response, the room
// gets one notice, a matching pull is flagged from the findings fixture, and
// the board chip is the same fact.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { searchActions } from "../server/mcp-action-search.mjs";
import { readProjectMap } from "../server/project-map-store.mjs";
import { PROJECT_MAP_ROUTES } from "../server/routes/project-map.mjs";
import { boardHtml } from "../src/board-ui.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/duplicate-pr-pairs.json", import.meta.url), "utf8"));
const helper = "export function helper() { return 1; }\n";
const caller = "import { helper } from \"./a.js\";\nexport function run() { return helper(); }\n";

async function room(t, featureEnv) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  if (featureEnv) store.featureEnv = featureEnv;
  const ownerKey = store.issueAccessKey("commons", "owner");
  const ada = store.identities.create("Ada");
  const bea = store.identities.create("Bea");
  for (const [identity, memberId, displayName] of [[ada, "ada", "Ada"], [bea, "bea", "Bea"]]) {
    store.identities.link(ownerKey, "commons", {
      identityId: identity.identityId, memberId, displayName, permissions: ["accept_work", "complete_work"]
    });
  }
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = secret => new RoomAgentClient({ origin, roomId: "commons", token: secret });
  return { store, origin, ada: client(ada.secret), bea: client(bea.secret), adaSecret: ada.secret, beaSecret: bea.secret };
}

const headers = secret => ({ "content-type": "application/json", authorization: `Bearer ${secret}` });

async function pushMap(origin, secret) {
  const response = await fetch(`${origin}/api/rooms/commons/map`, {
    method: "POST", headers: headers(secret),
    body: JSON.stringify({
      repo: "acme/widgets", revision: "abc",
      files: [{ path: "a.js", source: helper }, { path: "b.js", source: caller }]
    })
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

const notices = async client => (await client.changes(0, 100)).events
  .filter(row => row.event.type === "message.posted")
  .map(row => row.event.data.body)
  .filter(body => body.startsWith("Overlap:") || body.startsWith("Duplicate:"));

test("a claim learns the overlap before anyone writes more code, and the room posts it once", async t => {
  const { store, origin, ada, bea, adaSecret, beaSecret } = await room(t);
  const pushed = await pushMap(origin, adaSecret);
  assert.equal(pushed.engine, "parser");
  assert.equal(pushed.files, 2);
  assert.ok(PROJECT_MAP_ROUTES.some(route => route.parity === "mcp:room_map" && route.path.endsWith("/map/query")));
  const stored = readProjectMap(store, "commons", { op: "query", q: "helper", repo: "acme/widgets" });
  assert.equal(stored.kind, "symbol");
  const query = await fetch(`${origin}/api/rooms/commons/map/query?q=helper`, { headers: headers(adaSecret) });
  assert.equal(query.status, 200);
  const queried = await query.json();
  assert.equal(queried.kind, "symbol");
  assert.ok(queried.callers.some(call => call.file === "b.js"));

  await ada.workClaim("owner", { title: "Owner", files: ["a.js"], repo: "acme/widgets" });
  const claimed = await bea.workClaim("caller", { title: "Caller", files: ["b.js"], repo: "acme/widgets" });
  assert.equal(claimed.overlap.duplicate, false);
  assert.ok(claimed.overlap.symbols.includes("helper"));
  assert.match(claimed.overlap.summary, /^Overlap: /);
  assert.equal((await notices(ada)).length, 1);

  const noted = await fetch(`${origin}/api/rooms/commons/work-claims/caller/update`, {
    method: "POST", headers: headers(beaSecret),
    body: JSON.stringify({ note: "still the same files" })
  });
  assert.equal(noted.status, 200, await noted.clone().text());
  assert.equal((await notices(ada)).length, 1);

  const listed = await fetch(`${origin}/api/rooms/commons/work-claims`, { headers: headers(adaSecret) });
  const page = await listed.json();
  assert.ok(page.claims.some(item => item.id === "caller" && item.overlap?.symbols?.includes("helper")));
});

test("a new pull that matches an open pull is a duplicate, once", async t => {
  const { origin, ada, adaSecret } = await room(t);
  const group = fixture.duplicates[0];
  const send = (number, title) => fetch(`${origin}/api/rooms/commons/map/pulls`, {
    method: "POST", headers: headers(adaSecret),
    body: JSON.stringify({ repo: "uuriko/project-room", number, title, state: "open", files: group.files })
  });
  const first = await (await send(group.numbers[0], "Fail probe")).json();
  assert.equal(first.overlap, undefined);
  const second = await (await send(group.numbers[1], "Fail probe again")).json();
  assert.equal(second.overlap.duplicate, true);
  assert.match(second.overlap.summary, /^Duplicate: /);
  assert.ok(second.overlap.files.includes("scripts/unit-ci.mjs"));
  await send(group.numbers[1], "Fail probe again");
  const bodies = await notices(ada);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /PR #4507/);
  assert.match(bodies[0], /PR #4743/);
});

test("the map flag off stores nothing and posts nothing", async t => {
  const { origin, ada, bea, adaSecret } = await room(t, { ROOM_PROJECT_MAP: "off" });
  const pushed = await pushMap(origin, adaSecret);
  assert.deepEqual(pushed, { enabled: false, reason: "ROOM_PROJECT_MAP is off" });
  const query = await (await fetch(`${origin}/api/rooms/commons/map/hotspots`, { headers: headers(adaSecret) })).json();
  assert.equal(query.enabled, false);
  await ada.workClaim("left", { files: ["src/left.js"], repo: "acme/widgets", advisory: true });
  await bea.workClaim("right", { files: ["src/left.js"], repo: "acme/widgets", advisory: true });
  assert.equal((await notices(ada)).length, 0);
});

test("room_map answers hotspots over MCP and search finds it", async t => {
  const { origin, adaSecret } = await room(t);
  await pushMap(origin, adaSecret);
  const found = searchActions("map hotspots");
  assert.equal(found.matches[0].name, "room_map");
  assert.match(found.matches[0].rest, /GET \/api\/rooms\/\{roomId\}\/map\/query/);
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adaSecret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name: "room_map", arguments: { roomId: "commons", op: "hotspots" } } })
  });
  const body = await response.json();
  assert.equal(body.result?.isError, undefined);
  const hotspots = body.result.structuredContent?.hotspots ?? body.result.hotspots;
  assert.equal(hotspots[0].path, "a.js");
});

test("the board chip opens the overlap and stays off a claim that has none", () => {
  const overlap = {
    duplicate: false,
    with: [{ id: "owner", label: "Owner" }],
    files: [],
    symbols: ["helper"],
    shared: ["helper()"],
    summary: "Overlap: Caller and Owner share helper()."
  };
  const viewer = { id: "ada", manage: false, owner: false, write: true };
  const members = { ada: { id: "ada", displayName: "Ada" } };
  const withChip = boardHtml([
    { id: "caller", title: "Caller", state: "claimed", owner: "ada", files: ["b.js"], overlap }
  ], {}, viewer, members, Date.now());
  assert.match(withChip, /class="overlap-chip"/);
  assert.match(withChip, /<summary>Overlap<\/summary>/);
  assert.match(withChip, /helper\(\)/);
  assert.equal(withChip.includes("overlap-chip\"><summary>Overlap</summary>"), true);
  const plain = boardHtml([
    { id: "caller", title: "Caller", state: "claimed", owner: "ada", files: ["b.js"] }
  ], {}, viewer, members, Date.now());
  assert.equal(plain.includes("overlap-chip"), false);
});
