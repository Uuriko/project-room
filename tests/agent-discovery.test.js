import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { roomEntry, publicRoomDoorHtml } from "../deploy/room-entry.mjs";
import {
  agentCard, llmsTxt, llmsFullTxt, kitsTxt, agentCardJson, discoveryDoc, DISCOVERY_PATHS,
  SHORT_PACKET_FILES, SHORT_PACKET_SYNONYMS, AGENT_CARD_SYNONYMS, HEALTH_ALIAS_PATHS,
  KITS_CATALOG_PATH, KITS_CATALOG_SYNONYMS, KITS_CATALOG_FILES,
  isHealthAliasPath, A2A_PROTOCOL_VERSION, AGENT_CARD_A2A_PATH,
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
    "/api/health", "/llms.txt", "/llms-full.txt", "/kits.txt", "/.well-known/agent.json",
    "/.well-known/agent-card.json",
    ...SHORT_PACKET_FILES.map(name => `/${name}`),
    "/room/llms.txt", "/room/llms-full.txt", "/room/kits.txt", "/room/.well-known/agent.json",
    "/room/.well-known/agent-card.json",
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
  assert.match(text, /HTML door/);
  assert.match(text, /\/room\/llms.txt/);
  assert.equal(DISCOVERY_PATHS.includes("/room"), false);
  assert.equal(DISCOVERY_PATHS.includes("/room/"), false);
  assert.match(text, new RegExp(ROOM_PUBLIC_WWW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, new RegExp(ROOM_PUBLIC_LOBBY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /packet \(live, no account\)/);
  assert.match(text, /guest-agent-link \(live, owner-issued\)/);
  assert.match(text, /room_check_access/);
  assert.match(text, /orient/);
  assert.match(text, new RegExp(ROOM_DOCS.client.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(full, /queued \/ processing \/ active/);
  assert.match(full, /Compute is a separate/);
  assert.match(text, /\/kits\.txt/);
  assert.match(full, /\/kits\.txt/);
  assert.equal(FORBIDDEN.test(text), false);
  assert.equal(FORBIDDEN.test(full), false);
  assert.equal(FORBIDDEN.test(kitsTxt()), false);
  assert.equal(FORBIDDEN.test(agentCardJson()), false);
  assert.equal(JSON.parse(agentCardJson()).protocol, "project-room-discovery");
  assert.equal(card.protocolVersion, A2A_PROTOCOL_VERSION);
  assert.deepEqual(card.skills.map(row => row.id), ["orient", "room_check_access", "packet", "guest-agent-link", "enrolled-key"]);
  assert.equal(card.capabilities.streaming, true);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.deepEqual(card.defaultInputModes, ["text/plain"]);
  assert.equal(discoveryDoc(AGENT_CARD_A2A_PATH).body, discoveryDoc("/.well-known/agent.json").body);
  assert.equal(discoveryDoc("/room/.well-known/agent-card.json").body, discoveryDoc("/.well-known/agent.json").body);
  assert.equal(discoveryDoc("/project-room/.well-known/agent-card.json").body, discoveryDoc("/.well-known/agent.json").body);
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

test("www leftover synonyms serve the short packet or agent card, not 404", async t => {
  assert.deepEqual([...SHORT_PACKET_SYNONYMS], [
    "/room/skill", "/room/agents", "/room/llms",
    "/room/readme.md", "/room/README.md",
    "/room/gemini.md", "/room/GEMINI.md",
    "/room/cursor.md", "/room/CURSOR.md"
  ]);
  assert.deepEqual([...AGENT_CARD_SYNONYMS], ["/room/agent.json"]);
  const origin = await serve(t);
  const short = discoveryDoc("/llms.txt");
  const card = discoveryDoc("/.well-known/agent.json");
  for (const path of [...SHORT_PACKET_SYNONYMS, ...SHORT_PACKET_SYNONYMS.map(p => `${p}/`)]) {
    assert.equal(discoveryDoc(path).body, short.body, path);
    assert.equal(discoveryDoc(path).type, short.type, path);
    const get = await fetch(origin + path);
    assert.equal(get.status, 200, path);
    assert.equal(get.headers.get("content-type"), short.type, path);
    assert.equal(await get.text(), short.body, path);
  }
  for (const path of ["/room/agent.json", "/room/agent.json/"]) {
    assert.equal(discoveryDoc(path).body, card.body, path);
    const get = await fetch(origin + path);
    assert.equal(get.status, 200, path);
    assert.equal(get.headers.get("content-type"), card.type, path);
    assert.equal(await get.text(), card.body, path);
  }
  // Door roots stay out of ALIASES so HTML / Accept: text/plain keep working.
  assert.equal(discoveryDoc("/room"), null);
  assert.equal(discoveryDoc("/room/"), null);
});

test("kits catalog is its own packet; leftover kit/apps/tools paths do not 404", async t => {
  assert.equal(KITS_CATALOG_PATH, "/kits.txt");
  assert.deepEqual([...KITS_CATALOG_SYNONYMS], ["/room/kit", "/room/kits", "/room/apps", "/room/tools"]);
  assert.deepEqual([...KITS_CATALOG_FILES], [
    "kits.md", "kit.txt", "kit.md", "apps.txt", "apps.md", "tools.txt", "tools.md"
  ]);
  const catalog = discoveryDoc("/kits.txt");
  const short = discoveryDoc("/llms.txt");
  assert.notEqual(catalog.body, short.body);
  assert.match(catalog.type, /text\/plain/);
  assert.equal(catalog.body, kitsTxt());
  assert.match(catalog.body, /People and agents coordinate here\. Not Compute\./);
  assert.match(catalog.body, /This is a catalog\. Not an App Store\. No paid apps\./);
  assert.match(catalog.body, /packet \(live, no account\)/);
  assert.match(catalog.body, /guest-agent-link \(live, owner-issued\)/);
  assert.match(catalog.body, /enrolled-key \(live\)/);
  assert.match(catalog.body, /\/room\/llms\.txt/);
  assert.match(catalog.body, /\.well-known\/agent\.json/);
  assert.match(catalog.body, /\/health/);
  assert.match(catalog.body, /\/skill/);
  assert.match(catalog.body, /curl -sS/);
  assert.match(catalog.body, /follow Connect/);
  assert.doesNotMatch(catalog.body, /getone\.one|Amore|Accessibility|Mic\/Mac|people-data dump|paid app list/i);
  assert.equal(FORBIDDEN.test(catalog.body), false);
  const origin = await serve(t);
  const catalogPaths = [
    "/kits.txt", "/room/kits.txt", "/project-room/kits.txt",
    ...KITS_CATALOG_SYNONYMS, ...KITS_CATALOG_SYNONYMS.map(p => `${p}/`),
    ...KITS_CATALOG_FILES.flatMap(name => [`/${name}`, `/room/${name}`])
  ];
  for (const path of catalogPaths) {
    assert.ok(DISCOVERY_PATHS.includes(path), path);
    assert.equal(discoveryDoc(path).body, catalog.body, path);
    assert.equal(discoveryDoc(path).type, catalog.type, path);
    const get = await fetch(origin + path);
    assert.equal(get.status, 200, path);
    assert.equal(get.headers.get("content-type"), catalog.type, path);
    assert.equal(await get.text(), catalog.body, path);
    const head = await fetch(origin + path, { method: "HEAD" });
    assert.equal(head.status, 200, path);
    assert.equal(await head.text(), "");
  }
  // Skill leftovers stay the short packet, not the kits catalog.
  assert.equal(discoveryDoc("/room/skill").body, short.body);
  assert.notEqual(discoveryDoc("/room/kit").body, short.body);
});

test("/room/health aliases return the same JSON as /api/health; bare /health stays 404", async t => {
  assert.deepEqual([...HEALTH_ALIAS_PATHS], [
    "/room/health", "/room/health/", "/room/api/health", "/room/api/health/"
  ]);
  assert.equal(discoveryDoc("/room/health"), null, "health is API JSON, not a discovery doc");
  assert.equal(isHealthAliasPath("/api/health"), false);
  assert.equal(isHealthAliasPath("/health"), false);
  const origin = await serve(t);
  const canonical = await fetch(`${origin}/api/health`);
  assert.equal(canonical.status, 200);
  const expected = await canonical.json();
  assert.equal(expected.status, "ok");
  for (const path of HEALTH_ALIAS_PATHS) {
    const get = await fetch(origin + path);
    assert.equal(get.status, 200, path);
    assert.match(get.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await get.json(), expected, path);
    const head = await fetch(origin + path, { method: "HEAD" });
    assert.equal(head.status, 200, path);
    assert.equal(await head.text(), "");
  }
  const bare = await fetch(`${origin}/health`);
  assert.equal(bare.status, 404);
  assert.equal((await bare.json()).error.code, "not_found");
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
    "/room/skill", "/room/skill/", "/room/agents", "/room/llms",
    "/room/agent.json", "/room/readme.md", "/room/gemini.md", "/room/cursor.md",
    "/room/kits.txt", "/room/kits", "/room/kit", "/room/apps", "/room/tools",
    "/project-room/llms.txt", "/project-room/llms-full.txt", "/project-room/kits.txt",
    "/project-room/.well-known/agent.json"
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

test("advertised door root serves the HTML door; packets stay at /room/llms.txt", async (t) => {
  assert.equal(discoveryDoc("/room"), null);
  assert.equal(discoveryDoc("/room/"), null);
  assert.equal(discoveryDoc("/room/llms.txt").body, llmsTxt());
  assert.match(discoveryDoc("/room/llms.txt").type, /text\/plain/);
  const base = await serve(t);
  const door = publicRoomDoorHtml();
  for (const path of ["/room", "/room/"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.equal(await res.text(), door);
    const head = await fetch(`${base}${path}`, { method: "HEAD" });
    assert.equal(head.status, 200, path);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(`${base}${path}`, { method: "POST" })).status, 405, path);
    const plain = await fetch(`${base}${path}`, { headers: { Accept: "text/plain" } });
    assert.equal(plain.status, 200, path);
    assert.match(plain.headers.get("content-type"), /text\/plain/);
    assert.equal(await plain.text(), llmsTxt());
  }
  const workspace = await fetch(`${base}/`);
  assert.equal(workspace.status, 200);
  assert.match(workspace.headers.get("content-type"), /text\/html/);
  assert.match(await workspace.text(), /message-input/);
  const packet = await fetch(`${base}/room/llms.txt`);
  assert.equal(packet.status, 200);
  assert.match(packet.headers.get("content-type"), /text\/plain/);
  assert.equal(await packet.text(), llmsTxt());
});

test("edge door predicate: getdasha /room only, prefix preserved", () => {
  assert.deepEqual([...EDGE_DOOR_HOSTS], ["getdasha.com", "www.getdasha.com"]);
  for (const host of EDGE_DOOR_HOSTS) {
    for (const path of ["/room", "/room/", "/room/llms.txt", "/room/llms-full.txt", "/room/.well-known/agent.json", "/room/skill.md", "/room/skill", "/room/agent.json", "/room/health", "/room/kits", "/room/apps", "/room/tools"]) {
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

test("A2A agent card conforms to the official A2A 0.3.0 AgentCard shape", () => {
  // Validated 2026-09-12 against https://a2a-protocol.org/latest/specification/
  // (the card declares protocolVersion 0.3.0). Required top-level fields:
  // name, description, url, provider, version, capabilities,
  // defaultInputModes, defaultOutputModes, skills.
  const card = agentCard();
  for (const field of ["name", "description", "url", "version"]) {
    assert.equal(typeof card[field], "string");
    assert.ok(card[field].length > 0, field);
  }
  assert.equal(typeof card.provider.organization, "string");
  assert.equal(typeof card.provider.url, "string");
  assert.equal(typeof card.capabilities.streaming, "boolean");
  assert.equal(typeof card.capabilities.pushNotifications, "boolean");
  // Modes are defined as media types in the spec.
  const mime = value => typeof value === "string" && /^[a-z-]+\/[a-z0-9.+-]+$/.test(value);
  assert.ok(card.defaultInputModes.length > 0 && card.defaultInputModes.every(mime));
  assert.ok(card.defaultOutputModes.length > 0 && card.defaultOutputModes.every(mime));
  assert.ok(card.skills.length > 0);
  for (const skill of card.skills) {
    for (const field of ["id", "name", "description"]) assert.equal(typeof skill[field], "string", `skill.${field}`);
    assert.ok(Array.isArray(skill.tags) && skill.tags.length > 0, "skill.tags");
    assert.ok((skill.inputModes ?? []).every(mime) && (skill.outputModes ?? []).every(mime), "skill modes");
  }
  assert.equal(card.protocolVersion, A2A_PROTOCOL_VERSION);
});
