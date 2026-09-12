import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { roomEntry } from "../deploy/room-entry.mjs";
import {
  agentCard, llmsTxt, llmsFullTxt, agentCardJson, discoveryDoc, DISCOVERY_PATHS,
  SHORT_PACKET_FILES,
  ROOM_ORIGIN, ROOM_DOOR, ROOM_PUBLIC_WWW, ROOM_PUBLIC_LOBBY, COMPUTE_DOOR, ROOM_DOCS,
  EDGE_DOOR_HOSTS, isEdgeDoorUrl
} from "../deploy/agent-discovery.mjs";

const FORBIDDEN = /Bearer |ROOM_AGENT_TOKEN|sk-|password|@gmail|John |Potter |Uuriko@|acct-|memberId":"[^c]/i;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-discovery-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("discovery documents a ledger, not a run factory, with origin, doors and first tools", () => {
  const card = agentCard(), text = llmsTxt(), full = llmsFullTxt();
  assert.equal(card.url, ROOM_ORIGIN);
  assert.equal(card.base_url, ROOM_ORIGIN);
  assert.equal(card.door, ROOM_DOOR);
  assert.equal(card.public_doors.www, ROOM_PUBLIC_WWW);
  assert.equal(card.public_doors.lobby, ROOM_PUBLIC_LOBBY);
  assert.equal(card.product.kind, "ledger");
  assert.equal(card.product.not, "run factory");
  assert.equal(card.product.compute, COMPUTE_DOOR);
  assert.equal(card.endpoints.healthz, `${ROOM_ORIGIN}/api/health`);
  assert.deepEqual(card.key_routes.map(row => row.path), [
    "/api/health", "/llms.txt", "/llms-full.txt", "/.well-known/agent.json",
    ...SHORT_PACKET_FILES.map(name => `/${name}`),
    "/room/llms.txt", "/room/llms-full.txt", "/room/.well-known/agent.json",
    ...SHORT_PACKET_FILES.map(name => `/room/${name}`)
  ]);
  assert.deepEqual(card.join.map(row => row.id), ["packet", "guest-agent-link", "enrolled-key"]);
  assert.equal(card.join.find(row => row.id === "packet").status, "live");
  assert.equal(card.join.find(row => row.id === "guest-agent-link").status, "live");
  assert.equal(card.join.find(row => row.id === "enrolled-key").status, "live");
  assert.deepEqual(card.firstTools.map(row => row.name), ["room_check_access", "orient"]);
  assert.equal(card.capabilities.remoteMcp, false);
  assert.equal(card.capabilities.guestAgentLinkMint, true);
  assert.match(card.description, /Work Items/);
  assert.match(card.description, /receipts/i);
  assert.match(card.description, /Members/);
  assert.match(card.description, /Not a run factory/);
  assert.match(text, /Agent-native ledger/);
  assert.match(text, /Work Items \+ next actions \+ receipts/);
  assert.match(text, /Not a run factory/);
  assert.match(text, /Compute stays separate/);
  assert.match(text, new RegExp(ROOM_PUBLIC_WWW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, new RegExp(ROOM_PUBLIC_LOBBY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /packet \(live, no account\)/);
  assert.match(text, /guest-agent-link \(live, owner-issued\)/);
  assert.match(text, /room_check_access/);
  assert.match(text, /orient/);
  assert.match(text, new RegExp(ROOM_DOCS.client.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(full, /queued \/ processing \/ active/);
  assert.match(full, /Compute is a separate/);
  assert.equal(FORBIDDEN.test(text), false);
  assert.equal(FORBIDDEN.test(full), false);
  assert.equal(FORBIDDEN.test(agentCardJson()), false);
  assert.equal(JSON.parse(agentCardJson()).protocol, "project-room-discovery");
});

test("Room Worker serves llms.txt, llms-full.txt, agent.json and /room aliases", async t => {
  const origin = await serve(t);
  assert.ok(DISCOVERY_PATHS.includes("/llms-full.txt"));
  assert.ok(DISCOVERY_PATHS.includes("/room/llms.txt"));
  for (const path of DISCOVERY_PATHS) {
    const expected = discoveryDoc(path);
    const get = await fetch(origin + path);
    assert.equal(get.status, 200, path);
    assert.equal(get.headers.get("content-type"), expected.type);
    assert.equal(get.headers.get("x-robots-tag"), "all");
    assert.equal(await get.text(), expected.body);
    const head = await fetch(origin + path, { method: "HEAD" });
    assert.equal(head.status, 200, path);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(origin + path, { method: "POST" })).status, 405, path);
  }
  assert.equal(discoveryDoc("/room/llms.txt").body, discoveryDoc("/llms.txt").body);
  assert.equal(discoveryDoc("/room/llms-full.txt").body, discoveryDoc("/llms-full.txt").body);
  assert.equal(discoveryDoc("/room/.well-known/agent.json").body, discoveryDoc("/.well-known/agent.json").body);
});

test("conventional skill/agent filenames serve the same short packet as /llms.txt", async t => {
  assert.deepEqual([...SHORT_PACKET_FILES], ["skill.md", "agents.md", "AGENTS.md", "CLAUDE.md"]);
  const origin = await serve(t);
  const short = discoveryDoc("/llms.txt");
  for (const name of SHORT_PACKET_FILES) {
    for (const path of [`/${name}`, `/room/${name}`]) {
      assert.ok(DISCOVERY_PATHS.includes(path), path);
      assert.equal(discoveryDoc(path).body, short.body, path);
      assert.equal(discoveryDoc(path).type, short.type, path);
      const get = await fetch(origin + path);
      assert.equal(get.status, 200, path);
      assert.equal(await get.text(), short.body);
    }
  }
});

test("door serves the same discovery bytes and points at origin", async () => {
  const html = await roomEntry(new Request("https://www.trydemigod.com/room")).text();
  assert.match(html, /Connect an agent/);
  assert.match(html, /Start with a chat packet/);
  assert.match(html, /href="\/room\/llms.txt"/);
  assert.match(html, /href="\/room\/\.well-known\/agent\.json"/);
  for (const doorPath of [
    "/room/llms.txt", "/room/llms-full.txt", "/room/.well-known/agent.json",
    "/room/skill.md", "/room/agents.md", "/room/AGENTS.md", "/room/CLAUDE.md",
    "/project-room/llms.txt", "/project-room/llms-full.txt", "/project-room/.well-known/agent.json"
  ]) {
    const expected = discoveryDoc(doorPath);
    const get = roomEntry(new Request(`https://www.trydemigod.com${doorPath}`));
    assert.equal(get.status, 200, doorPath);
    assert.equal(get.headers.get("content-type"), expected.type);
    assert.equal(await get.text(), expected.body);
    assert.equal(await roomEntry(new Request(`https://www.trydemigod.com${doorPath}`, { method: "HEAD" })).text(), "");
    assert.equal(roomEntry(new Request(`https://www.trydemigod.com${doorPath}`, { method: "POST" })).status, 405);
  }
});

test("advertised door root serves the llms.txt entry doc, never 404", async (t) => {
  for (const path of ["/room", "/room/"]) {
    const doc = discoveryDoc(path);
    assert.equal(doc?.body, llmsTxt());
    assert.match(doc.type, /text\/plain/);
  }
  const base = await serve(t);
  for (const path of ["/room", "/room/"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), llmsTxt());
  }
  // The demigod door root stays the human HTML door page (covered above);
  // the worker origin and getdasha edge doors serve the llms.txt alias.
});

test("edge door predicate: getdasha /room only, prefix preserved", () => {
  assert.deepEqual([...EDGE_DOOR_HOSTS], ["getdasha.com", "www.getdasha.com"]);
  for (const host of EDGE_DOOR_HOSTS) {
    for (const path of ["/room", "/room/", "/room/llms.txt", "/room/llms-full.txt", "/room/.well-known/agent.json", "/room/skill.md"]) {
      assert.equal(isEdgeDoorUrl(`https://${host}${path}`), true, `${host}${path}`);
    }
  }
  assert.equal(isEdgeDoorUrl("https://getdasha.com/roomful"), false, "prefix lookalike");
  assert.equal(isEdgeDoorUrl("https://getdasha.com/"), false, "apex root stays with Webflow");
  assert.equal(isEdgeDoorUrl("https://www.getdasha.com/.well-known/agent.json"), false, "Compute card untouched");
  assert.equal(isEdgeDoorUrl("https://getdasha.com/compute"), false, "Compute untouched");
  assert.equal(isEdgeDoorUrl("https://lobby.getdasha.com/room/llms.txt"), false, "lobby host stays with dasha-lobby");
  assert.equal(isEdgeDoorUrl(`${ROOM_ORIGIN}/room/llms.txt`), false, "worker origin is direct, not a door");
  assert.equal(isEdgeDoorUrl("https://www.trydemigod.com/room"), false, "demigod door handled by room-entry");
});

test("edge door routes use wildcard patterns so query strings never fall through", async () => {
  // CF exact route patterns drop the query string: /room?ref= fell through to the
  // lobby wildcard and html-404d. Wildcards keep the advertised door on the worker.
  const { readFileSync } = await import("node:fs");
  const wrangler = readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /"pattern": "(?:www\.)?getdasha\.com\/room"/, "exact /room patterns drop query strings");
  assert.match(wrangler, /"pattern": "getdasha\.com\/room\*"/);
  assert.match(wrangler, /"pattern": "www\.getdasha\.com\/room\*"/);
  // The tradeoff is bounded: /roomful junk now reaches the worker and 403s at the
  // origin guard instead of 404ing; isEdgeDoorUrl keeps it out of the door rewrite.
  assert.equal(isEdgeDoorUrl("https://www.getdasha.com/roomful"), false);
  assert.equal(isEdgeDoorUrl("https://www.getdasha.com/room?ref=x"), true);
});
