import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { roomEntry, publicRoomDoorHtml } from "../deploy/room-entry.mjs";
import {
  agentCard, llmsTxt, llmsFullTxt, kitsTxt, agentCardJson, agentsJson, discoveryDoc, DISCOVERY_PATHS,
  AFTER_PASTE_SECTION, joinPrompt, JOIN_HOSTS, JOIN_PROMPT_PATH, SHORT_PACKET_FILES, SHORT_PACKET_SYNONYMS, AGENT_CARD_SYNONYMS, HEALTH_ALIAS_PATHS,
  KITS_CATALOG_PATH, KITS_CATALOG_SYNONYMS, KITS_CATALOG_FILES, AGENTS_JSON_PATH,
  isHealthAliasPath, rewriteRoomApiPrefix, edgeDoorApiPath, DISCOVERY_PROTOCOL_VERSION, AGENT_CARD_A2A_PATH,
  ROOM_ORIGIN, ROOM_DOOR, ROOM_PUBLIC_WWW, COMPUTE_DOOR, ROOM_DOCS,
  EDGE_DOOR_HOSTS, isEdgeDoorUrl
} from "../deploy/agent-discovery.mjs";

const FORBIDDEN = /Bearer (?!<saved-identity-secret>)|ROOM_AGENT_TOKEN|sk-|password|@gmail|John |Potter |Uuriko@|acct-|memberId":"[^c]/i;

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
  assert.equal("lobby" in card.public_doors, false); // dead door, never advertised
  assert.equal(card.product.kind, "ledger");
  assert.equal(card.product.not, "run factory");
  assert.equal(card.product.compute, COMPUTE_DOOR);
  assert.equal(card.endpoints.healthz, `${ROOM_ORIGIN}/api/health`);
  assert.deepEqual(card.key_routes.map(row => row.path), [
    "/api/health", "/llms.txt", "/join.txt", "/mcp", "/mcp/server-card", "/.well-known/mcp.json", "/room/mcp", "/room/mcp/server-card", "/llms-full.txt", "/kits.txt", "/skills", "/agents.json", "/.well-known/agent.json", "/.well-known/governance.json", "/openapi.json",
    "/.well-known/agent-card.json", "/.well-known/ai-catalog.json", "/.well-known/ard.json", "/robots.txt", "/agent.json",
    "/agent-card.json",
    ...SHORT_PACKET_FILES.map(name => `/${name}`),
    "/room/llms.txt", "/room/join.txt", "/room/llms-full.txt", "/room/kits.txt", "/room/agents.json", "/room/.well-known/agent.json",
    "/room/.well-known/agent-card.json",
    ...SHORT_PACKET_FILES.map(name => `/room/${name}`)
  ]);
  assert.deepEqual(card.join.map(row => row.id), ["packet", "guest-agent-link", "enrolled-key", "identity-mint", "agent-room-create", "invite-redeem", "hosted-mcp"]);
  assert.equal(card.join.find(row => row.id === "packet").status, "live");
  assert.equal(card.join.find(row => row.id === "guest-agent-link").status, "live");
  assert.equal(card.join.find(row => row.id === "enrolled-key").status, "live");
  assert.equal(card.join.find(row => row.id === "hosted-mcp").status, "live");
  assert.deepEqual(card.firstTools.map(row => row.name), ["room_check_access", "orient"]);
  assert.equal(card.capabilities["guest-agent-links"], true);
  assert.equal(card.capabilities["agent-keys"], true);
  assert.equal(card.capabilities["agent-rooms"], true);
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
  assert.equal(DISCOVERY_PATHS.includes("/mcp"), false);
  assert.equal(DISCOVERY_PATHS.includes("/room/mcp"), false);
  assert.match(text, new RegExp(ROOM_PUBLIC_WWW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(text.includes("lobby.getdasha.com"), false); // dead door, never advertised
  assert.match(text, /Humans: open this invite link/);
  assert.match(text, /https:\/\/www\.getdasha\.com\/room\/#join\//);
  assert.match(text, /#room\/\{roomId\} is not an invite/);
  assert.match(text, /Agent invite code \/ redeem-invite is labeled below/);
  assert.match(text, /packet \(live, no account\)/);
  assert.match(text, /paste-prompt \(live, no account\)/);
  assert.match(text, /GET \/join\.txt/);
  assert.match(text, /guest-agent-link \(live, owner-issued\)/);
  assert.match(text, /agent-room-create \(live, no account\)/);
  assert.match(text, /bootstrap-agent-room/);
  assert.match(text, /cli, not a live HTTP POST/);
  assert.match(text, /no POST \/api\/bootstrap-agent-room/);
  assert.match(text, /\/room\/api\/agent-identities/);
  assert.match(text, /\/room\/api\/agent-rooms/);
  assert.match(text, /\/room\/api\/agent-invites\/redeem/);
  assert.match(text, /hosted-mcp \(live, no account\)/);
  assert.match(text, /https:\/\/www\.getdasha\.com\/room\/mcp/);
  assert.match(text, /human-join-code \(live\)/);
  assert.match(text, /www.getdasha.com \(no \/room path\)/);
  assert.match(text, /room_check_access/);
  assert.match(text, /orient/);
  assert.match(text, new RegExp(ROOM_DOCS.client.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(full, /queued \/ processing \/ active/);
  assert.match(full, /Compute is a separate/);
  assert.match(text, /\/kits\.txt/);
  assert.match(full, /\/kits\.txt/);
  assert.equal(FORBIDDEN.test(text), false);
  assert.equal(FORBIDDEN.test(full), false);
  assert.match(card.skills.find(row => row.id === "packet").description, /After paste/);
  assert.equal(FORBIDDEN.test(kitsTxt()), false);
  assert.equal(FORBIDDEN.test(agentCardJson()), false);
  assert.equal(JSON.parse(agentCardJson()).protocol, "project-room-discovery");
  assert.equal(card.protocolVersion, DISCOVERY_PROTOCOL_VERSION);
  assert.deepEqual(card.skills.map(row => row.id), ["muse-room", "orient", "claims-board", "room_check_access", "packet", "guest-agent-link", "enrolled-key", "identity-mint", "agent-room-create", "invite-redeem", "hosted-mcp"]);
  assert.equal(card.capabilities["agent-identities"], true);
  assert.equal(card.capabilities["webhooks"], true);
  assert.deepEqual(card.defaultInputModes, ["text/plain"]);
  assert.equal(discoveryDoc(AGENT_CARD_A2A_PATH).body, discoveryDoc("/.well-known/agent.json").body);
  assert.equal(discoveryDoc("/room/.well-known/agent-card.json").body, discoveryDoc("/.well-known/agent.json").body);
  assert.equal(discoveryDoc("/project-room/.well-known/agent-card.json").body, discoveryDoc("/.well-known/agent.json").body);
});

test("short and full packets tell a pasted agent the next action; kits and door stay off", () => {
  const text = llmsTxt(), full = llmsFullTxt();
  assert.match(AFTER_PASTE_SECTION, /^## After paste \(you are the agent\)\n/);
  assert.match(AFTER_PASTE_SECTION, /No separate agent invite code, human login, or room-owner approval/);
  assert.match(AFTER_PASTE_SECTION, /fragment after # is not sent/);
  assert.match(AFTER_PASTE_SECTION, /POST \/api\/share-links\/join-agent/);
  assert.match(AFTER_PASTE_SECTION, /GET \/api\/rooms\/ROOM_ID\/activation-pack/);
  assert.doesNotMatch(AFTER_PASTE_SECTION, /#join\/ ≠ agent auth|Waiting for Paste AI draft/);
  for (const packet of [text, full]) {
    const joinAt = packet.indexOf("## Join\n");
    const afterAt = packet.indexOf(AFTER_PASTE_SECTION);
    const routesAt = packet.indexOf("## Routes\n");
    assert.ok(joinAt >= 0, "Join present");
    assert.ok(afterAt > joinAt, "After paste follows Join");
    assert.ok(routesAt > afterAt, "Routes follow After paste");
    assert.equal(packet.includes(AFTER_PASTE_SECTION), true);
    assert.match(packet, /Humans: open this invite link \(https:\/\/www\.getdasha\.com\/room\/#join\/…\)/);
    assert.match(packet, /#room\/\{roomId\} is not an invite/);
  }
  assert.equal(kitsTxt().includes(AFTER_PASTE_SECTION), false, "kits catalog stays packet-off");
  assert.equal(kitsTxt().includes("## After paste"), false);
  const packetSkill = agentCard().skills.find(row => row.id === "packet");
  assert.match(packetSkill.description, /After paste/);
  assert.match(packetSkill.description, /shared invitation/);
  assert.doesNotMatch(agentCardJson(), FORBIDDEN);
});

test("join prompt is one paste, secret-free, and served at /join.txt", () => {
  const prompt = joinPrompt();
  assert.equal(JOIN_PROMPT_PATH, "/join.txt");
  assert.deepEqual([...JOIN_HOSTS], ["Cursor", "Grok Bot", "ChatGPT", "Codex", "Claude", "MCP"]);
  assert.match(prompt, /^Join Uuriko Project Room as an agent\.\n/);
  assert.match(prompt, /\/llms\.txt/);
  assert.match(prompt, /After paste/);
  assert.match(prompt, /HTTP-only agents/);
  assert.match(prompt, /your own saved identity/);
  assert.doesNotMatch(prompt, FORBIDDEN);
  assert.doesNotMatch(prompt, /chatgpt\.com|ChatGPT Sites/i);
  assert.equal(discoveryDoc("/join.txt").body, prompt);
  assert.equal(discoveryDoc("/room/join.txt").body, prompt);
  assert.equal(discoveryDoc("/project-room/join.txt").body, prompt);
  assert.match(discoveryDoc("/join.txt").type, /text\/plain/);
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
    // RC-2026-09-24-202: the node server injects the live `members` array
    // (opted-in skill cards) into the /skills catalog and its aliases. The
    // scratch server has no published cards, so the served body is the
    // static doc plus `"members": []`.
    const expectedBody = discoveryDoc(path) === discoveryDoc("/skills")
      ? JSON.stringify({ ...JSON.parse(expected.body), members: [] }, null, 2) + "\n"
      : expected.body;
    assert.equal(await get.text(), expectedBody, path);
    const head = await fetch(origin + path, { method: "HEAD" });
    assert.equal(head.status, 200, path);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(origin + path, { method: "POST" })).status, 405, path);
  }
  assert.equal(discoveryDoc("/room/llms.txt").body, discoveryDoc("/llms.txt").body);
  assert.equal(discoveryDoc("/room/llms-full.txt").body, discoveryDoc("/llms-full.txt").body);
  assert.equal(discoveryDoc("/room/.well-known/agent.json").body, discoveryDoc("/.well-known/agent.json").body);
});

test("agents.json is a machine-readable flows/steps/actions doc served at /agents.json and /room aliases", async t => {
  const body = agentsJson();
  assert.match(body, /^[{[]/);
  assert.ok(!FORBIDDEN.test(body), "agents.json must stay secret-free and people-free");
  const doc = JSON.parse(body);
  assert.equal(doc.convention, "agents.json");
  assert.equal(doc.name, "Project Room");
  assert.equal(doc.url, ROOM_ORIGIN);
  assert.equal(doc.card, `${ROOM_ORIGIN}/.well-known/agent.json`);
  assert.equal(doc.packet, `${ROOM_ORIGIN}/llms.txt`);
  assert.deepEqual(Object.keys(doc.doors), ["origin", "demigod", "www"]);
  assert.match(doc.doors.www, /^https:\/\//);
  assert.ok(doc.docs.plug_in.endsWith("docs/SWARM-PLUG-IN.md"), "enrollment guide linked");
  assert.deepEqual(doc.flows.map(flow => flow.id),
    ["discover", "enroll", "create-room", "join-invite", "join-mcp", "claim-work", "coordinate-swarm"]);
  for (const flow of doc.flows) {
    assert.ok(flow.id && flow.name && flow.description, `flow ${flow.id} has id/name/description`);
    assert.ok(Array.isArray(flow.steps) && flow.steps.length > 0, `flow ${flow.id} has steps`);
    for (const step of flow.steps) {
      assert.ok(step.id && step.name && step.description, `step ${step.id} has id/name/description`);
      assert.ok(Array.isArray(step.actions) && step.actions.length > 0, `step ${step.id} has actions`);
      for (const action of step.actions) {
        assert.ok(action.type && action.method && action.url && action.description,
          `action in step ${step.id} has type/method/url/description`);
        assert.ok(["none", "required"].includes(action.authentication),
          `action in step ${step.id} declares authentication`);
      }
    }
  }
  const actionUrls = doc.flows.flatMap(flow => flow.steps).flatMap(step => step.actions).map(a => a.url);
  assert.ok(actionUrls.includes(`${ROOM_ORIGIN}/api/agent-identities`), "identity self-mint present");
  assert.ok(actionUrls.includes(`${ROOM_ORIGIN}/api/agent-rooms`), "agent room create present");
  assert.ok(actionUrls.includes(`${ROOM_ORIGIN}/api/agent-invites/redeem`), "invite redeem present");
  assert.ok(actionUrls.some(url => url.includes("/work-claims")), "work claim endpoints present");
  // Served: canonical + prefix-preserving edge aliases, JSON content type.
  assert.equal(AGENTS_JSON_PATH, "/agents.json");
  const canonical = discoveryDoc("/agents.json");
  assert.equal(canonical.type, "application/json; charset=utf-8");
  assert.equal(canonical.body, body);
  assert.equal(discoveryDoc("/room/agents.json").body, body);
  assert.equal(discoveryDoc("/room/agents.json/").body, body);
  assert.equal(discoveryDoc("/project-room/agents.json").body, body);
  assert.ok(DISCOVERY_PATHS.includes("/agents.json"));
  assert.ok(DISCOVERY_PATHS.includes("/room/agents.json"));
  const origin = await serve(t);
  const get = await fetch(origin + "/agents.json");
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(await get.text()), doc);
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
    "kits.json", "kits.md", "kit.txt", "kit.md", "apps.txt", "apps.md", "tools.txt", "tools.md"
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
  assert.match(catalog.body, /agent-room-create \(live, no account\)/);
  assert.match(catalog.body, /hosted-mcp \(live, no account\)/);
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
    "/kits.txt", "/kits", "/kits/", "/room/kits.txt", "/project-room/kits.txt",
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

test("rewriteRoomApiPrefix strips only /room/api…; packets and /room/health stay", () => {
  assert.equal(rewriteRoomApiPrefix("/room/api/agent-identities"), "/api/agent-identities");
  assert.equal(rewriteRoomApiPrefix("/room/api/agent-rooms"), "/api/agent-rooms");
  assert.equal(rewriteRoomApiPrefix("/room/api/agent-invites/redeem"), "/api/agent-invites/redeem");
  assert.equal(rewriteRoomApiPrefix("/room/api/rooms/grok-den/agent-invites"), "/api/rooms/grok-den/agent-invites");
  assert.equal(rewriteRoomApiPrefix("/room/api/health"), "/api/health");
  assert.equal(rewriteRoomApiPrefix("/room/api/health/"), "/api/health/");
  assert.equal(rewriteRoomApiPrefix("/room/api"), "/api");
  assert.equal(rewriteRoomApiPrefix("/api/agent-rooms"), "/api/agent-rooms");
  assert.equal(rewriteRoomApiPrefix("/room/health"), "/room/health");
  assert.equal(rewriteRoomApiPrefix("/room/llms.txt"), "/room/llms.txt");
  assert.equal(rewriteRoomApiPrefix("/room/apitest"), "/room/apitest");
  assert.equal(rewriteRoomApiPrefix("/rooms/api/agent-rooms"), "/rooms/api/agent-rooms");
});

test("edgeDoorApiPath prefixes /room on getdasha hosts only", () => {
  assert.equal(edgeDoorApiPath("https://www.getdasha.com", "/api/agent-rooms"), "/room/api/agent-rooms");
  assert.equal(edgeDoorApiPath("https://getdasha.com", "/api/agent-identities"), "/room/api/agent-identities");
  assert.equal(edgeDoorApiPath("https://www.getdasha.com", "/room/api/agent-rooms"), "/room/api/agent-rooms");
  assert.equal(edgeDoorApiPath("https://project-room-staging.getdasha.workers.dev", "/api/agent-rooms"), "/api/agent-rooms");
  assert.equal(edgeDoorApiPath("https://www.trydemigod.com", "/api/agent-rooms"), "/api/agent-rooms");
  assert.equal(edgeDoorApiPath("https://www.getdasha.com", "/llms.txt"), "/llms.txt");
});

test("/room/health aliases return the same JSON as /api/health; bare /health stays 404", async t => {
  assert.deepEqual([...HEALTH_ALIAS_PATHS], [
    "/room/health", "/room/health/", "/room/api/health", "/room/api/health/",
    "/api/healthz", "/api/healthz/", "/healthz", "/healthz/",
    "/room/healthz", "/room/healthz/", "/room/api/healthz", "/room/api/healthz/"
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
  // Door copy is plain language now (see tests/room-entry.test.js for the full set).
  assert.match(html, /Invite teammates and AI agents to work on the same items together/);
  assert.match(html, /Rooms are private by default\. Adding an agent never lists the room publicly/);
  assert.match(html, /choose “Use my AI” and paste the agent packet/);
  assert.match(html, /href="\/room\/llms.txt"/);
  assert.match(html, /href="\/room\/\.well-known\/agent\.json"/);
  for (const doorPath of [
    "/room/llms.txt", "/room/join.txt", "/room/llms-full.txt", "/room/.well-known/agent.json",
    "/room/skill.md", "/room/agents.md", "/room/AGENTS.md", "/room/CLAUDE.md",
    "/room/skill", "/room/skill/", "/room/agents", "/room/llms",
    "/room/agent.json", "/room/readme.md", "/room/gemini.md", "/room/cursor.md",
    "/room/kits.txt", "/room/kits", "/room/kit", "/room/apps", "/room/tools",
    "/project-room/llms.txt", "/project-room/join.txt", "/project-room/llms-full.txt", "/project-room/kits.txt",
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
    for (const path of ["/room", "/room/", "/room/llms.txt", "/room/join.txt", "/room/llms-full.txt", "/room/.well-known/agent.json", "/room/skill.md", "/room/skill", "/room/agent.json", "/room/health", "/room/kits", "/room/apps", "/room/tools", "/room/api/agent-rooms", "/room/api/agent-identities", "/room/api/identity-create", "/room/api/agent-invites/redeem"]) {
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
  const roomWorker = readFileSync(new URL("../cloudflare/room.mjs", import.meta.url), "utf8");
  assert.match(roomWorker, /rewriteRoomApiPrefix/, "edge rewrite must strip /room/api so enrollment is not AX not_found");
  // The tradeoff is bounded: /roomful junk reaches the worker, which answers a plain
  // 404 for edge-door hosts (not the origin guard's 403); isEdgeDoorUrl keeps it out of the door rewrite.
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
  // #601: capabilities are build-time route-family booleans plus a stale flag.
  for (const family of ["agent-identities", "agent-invites", "agent-keys", "agent-rooms",
      "guest-agent-links", "directory", "agent-inbox", "collab", "webhooks",
      "public-face", "spend-allowance"]) {
    assert.equal(typeof card.capabilities[family], "boolean", family);
  }
  assert.equal(typeof card.capabilities.stale, "boolean");
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
  assert.equal(card.protocolVersion, DISCOVERY_PROTOCOL_VERSION);
});

test("A2A agent card declares the work-receipt extension (docs/a2a-receipt-extension.md)", () => {
  // Interop contract: any A2A client fetching /.well-known/agent-card.json
  // must be able to discover receipt support. Guarded here because the
  // declaration is a single line in the capabilities literal — a careless
  // rebase could drop it and clients would silently lose discovery.
  const card = agentCard();
  assert.ok(Array.isArray(card.capabilities.extensions), "capabilities.extensions");
  const ext = card.capabilities.extensions.find(e => e.uri === "https://room.trydemigod.com/extensions/work-receipt/v1");
  assert.ok(ext, "work-receipt extension declared");
  assert.equal(ext.required, false, "extension is declarative, never a gate");
  assert.equal(ext.params.schema_version, "project-room-receipt/1");
  assert.match(ext.params.spec_url, /a2a-receipt-extension\.md$/);
});

// ============================================================================
// B029-2 [quill-s2]: pure A2A agent discovery planner (../src/agent-discovery.mjs)
//
// NOTE: the tests above cover deploy/agent-discovery.mjs (the room's public
// discovery documents). Everything below covers the src/ discovery planner
// only and must not touch the room-discovery tests above.
import {
  createAgentDiscovery,
  DEFAULT_CACHE_TTL_MS,
  DISCOVERY_ERROR_CODES,
} from "../src/agent-discovery.mjs";
import { EventEmitter } from "node:events";

function fakeCard({ agentId, lanes = [], tools = [], skills = [], capabilities, version = 1 }) {
  const card = { version, agentId, lanes, tools };
  if (skills.length > 0) card.skills = skills;
  if (capabilities !== undefined) card.capabilities = capabilities;
  return Object.freeze(card);
}

const PLANNER_CARDS = [
  fakeCard({ agentId: "alpha", lanes: ["summarize", "translate"], tools: ["gmail-send"], version: 2 }),
  fakeCard({ agentId: "beta", lanes: ["summarize"], tools: [], version: 5, skills: ["summarize-prose"] }),
  fakeCard({ agentId: "gamma", lanes: ["translate"], tools: ["gmail-send", "calendar-read"], version: 1 }),
  fakeCard({ agentId: "delta", lanes: ["deploy"], tools: ["ssh"], version: 9 }),
];

function fakeRegistry(cards = PLANNER_CARDS) {
  let listCalls = 0;
  return {
    list: () => { listCalls += 1; return cards; },
    get listCalls() { return listCalls; },
  };
}

function manualClock(start = 1_000_000) {
  let now = start;
  const fn = () => now;
  fn.advance = (ms) => { now += ms; };
  return fn;
}

class EmittingRegistry extends EventEmitter {
  constructor(cards = PLANNER_CARDS) {
    super();
    this.cards = cards;
    this.listCalls = 0;
  }
  list() {
    this.listCalls += 1;
    return this.cards;
  }
}

/** Assert fn() throws an Error whose code === expected. */
function assertCoded(fn, expected) {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof Error, `expected an Error with code ${expected}, got ${thrown}`);
  assert.equal(typeof thrown.code, "string", "thrown error must carry a string code");
  assert.equal(thrown.code, expected);
}

test("B029-2: discover ranks agents by capability coverage ratio", () => {
  const discovery = createAgentDiscovery({ cardRegistry: fakeRegistry() });
  const results = discovery.discover({ capabilities: ["summarize", "translate", "gmail-send"] });
  assert.deepEqual(results.map((r) => r.agentId), ["alpha", "gamma", "beta"]);
  assert.equal(results[0].score, 1); // alpha covers 3/3
  assert.equal(results[1].score, 2 / 3); // gamma covers 2/3
  assert.equal(results[2].score, 1 / 3); // beta covers 1/3
  assert.deepEqual(results[0].matchedCapabilities, ["gmail-send", "summarize", "translate"]);
  assert.deepEqual(results[1].matchedCapabilities, ["gmail-send", "translate"]);
  assert.deepEqual(results[2].matchedCapabilities, ["summarize"]);
  assert.equal(results[0].card.agentId, "alpha", "each result carries its card");
});

test("B029-2: capability matching is duck-typed across card shapes", () => {
  const registry = fakeRegistry([
    fakeCard({ agentId: "duck", lanes: [], tools: [], capabilities: ["custom-cap"], version: 1 }),
    fakeCard({ agentId: "lanes", lanes: ["custom-cap"], version: 1 }),
  ]);
  const discovery = createAgentDiscovery({ cardRegistry: registry });
  const results = discovery.discover({ capabilities: ["custom-cap"] });
  // Equal score and version: tiebreak falls to agentId ascending.
  assert.deepEqual(results.map((r) => r.agentId), ["duck", "lanes"]);
});

test("B029-2: tiebreak is version desc, then agentId asc", () => {
  const registry = fakeRegistry([
    fakeCard({ agentId: "zeta", lanes: ["summarize"], version: 1 }),
    fakeCard({ agentId: "eta", lanes: ["summarize"], version: 7 }),
    fakeCard({ agentId: "theta", lanes: ["summarize"], version: 7 }),
  ]);
  const discovery = createAgentDiscovery({ cardRegistry: registry });
  const results = discovery.discover({ capabilities: ["summarize"] });
  assert.deepEqual(results.map((r) => r.agentId), ["eta", "theta", "zeta"]);
});

test("B029-2: discover throws AD_NO_MATCH when no agent matches any capability", () => {
  const discovery = createAgentDiscovery({ cardRegistry: fakeRegistry() });
  assertCoded(() => discovery.discover({ capabilities: ["definitely-not-a-capability"] }), "AD_NO_MATCH");
});

test("B029-2: limit caps the ranked list from the top", () => {
  const discovery = createAgentDiscovery({ cardRegistry: fakeRegistry() });
  const results = discovery.discover({ capabilities: ["summarize", "translate", "gmail-send"], limit: 2 });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.agentId), ["alpha", "gamma"]);
});

test("B029-2: excludeAgentIds removes agents from contention", () => {
  const discovery = createAgentDiscovery({ cardRegistry: fakeRegistry() });
  const results = discovery.discover({
    capabilities: ["summarize", "translate", "gmail-send"],
    excludeAgentIds: ["alpha", "gamma"],
  });
  assert.deepEqual(results.map((r) => r.agentId), ["beta"]);
  // Excluding every contender is a no-match, never an empty silent list.
  assertCoded(
    () => discovery.discover({
      capabilities: ["summarize", "translate", "gmail-send"],
      excludeAgentIds: ["alpha", "beta", "gamma"],
    }),
    "AD_NO_MATCH",
  );
});

test("B029-2: skills filter requires every requested skill", () => {
  const discovery = createAgentDiscovery({ cardRegistry: fakeRegistry() });
  const results = discovery.discover({ capabilities: ["summarize"], skills: ["summarize-prose"] });
  assert.deepEqual(results.map((r) => r.agentId), ["beta"]);
  assertCoded(
    () => discovery.discover({ capabilities: ["summarize"], skills: ["no-such-skill"] }),
    "AD_NO_MATCH",
  );
});

test("B029-2: findForTask wraps discover for a task description", () => {
  const discovery = createAgentDiscovery({ cardRegistry: fakeRegistry() });
  const viaWrapper = discovery.findForTask("write a summary and translate it", ["summarize", "translate"]);
  const viaDiscover = discovery.discover({ capabilities: ["summarize", "translate"] });
  assert.deepEqual(viaWrapper.map((r) => r.agentId), viaDiscover.map((r) => r.agentId));
  assert.equal(viaWrapper[0].agentId, "alpha");
  assertCoded(() => discovery.findForTask("", ["summarize"]), "AD_INVALID_QUERY");
  assertCoded(() => discovery.findForTask("   ", ["summarize"]), "AD_INVALID_QUERY");
  assertCoded(() => discovery.findForTask(42, ["summarize"]), "AD_INVALID_QUERY");
  assertCoded(() => discovery.findForTask("task", []), "AD_INVALID_QUERY");
});

test("B029-2: repeated identical queries hit the cache", () => {
  const clock = manualClock();
  const registry = fakeRegistry();
  const discovery = createAgentDiscovery({ cardRegistry: registry, clock });
  const query = { capabilities: ["summarize", "translate"] };
  const first = discovery.discover(query);
  const second = discovery.discover(query);
  assert.equal(registry.listCalls, 1, "second query must not re-enumerate the registry");
  assert.deepEqual(second, first);
  assert.deepEqual(discovery.stats(), { queries: 2, hits: 1, misses: 1 });
  // Caller-side mutation of a returned array must not corrupt the cache.
  second.push({ agentId: "spoofed" });
  const third = discovery.discover(query);
  assert.equal(third.length, first.length);
  assert.equal(registry.listCalls, 1);
});

test("B029-2: cache entries expire after the injected TTL", () => {
  const clock = manualClock();
  const registry = fakeRegistry();
  const discovery = createAgentDiscovery({ cardRegistry: registry, clock, cacheTtlMs: 1000 });
  discovery.discover({ capabilities: ["summarize"] });
  clock.advance(999);
  discovery.discover({ capabilities: ["summarize"] });
  assert.equal(registry.listCalls, 1, "still fresh just before the TTL");
  clock.advance(2);
  discovery.discover({ capabilities: ["summarize"] });
  assert.equal(registry.listCalls, 2, "re-enumerates once the TTL elapses");
  assert.deepEqual(discovery.stats(), { queries: 3, hits: 1, misses: 2 });
});

test("B029-2: default cache TTL is 60s and honors the injected clock", () => {
  assert.equal(DEFAULT_CACHE_TTL_MS, 60 * 1000);
  const clock = manualClock();
  const registry = fakeRegistry();
  const discovery = createAgentDiscovery({ cardRegistry: registry, clock });
  discovery.discover({ capabilities: ["summarize"] });
  clock.advance(60 * 1000);
  discovery.discover({ capabilities: ["summarize"] });
  assert.equal(registry.listCalls, 1, "TTL boundary is inclusive");
  clock.advance(1);
  discovery.discover({ capabilities: ["summarize"] });
  assert.equal(registry.listCalls, 2);
});

test("B029-2: registry change events invalidate the cache", () => {
  const registry = new EmittingRegistry();
  const discovery = createAgentDiscovery({ cardRegistry: registry });
  discovery.discover({ capabilities: ["summarize"] });
  discovery.discover({ capabilities: ["summarize"] });
  assert.equal(registry.listCalls, 1);
  registry.emit("change");
  discovery.discover({ capabilities: ["summarize"] });
  assert.equal(registry.listCalls, 2, "change event must drop cached results");
});

test("B029-2: registries without change events degrade gracefully to TTL-only", () => {
  const plain = fakeRegistry();
  assert.equal(typeof plain.on, "undefined");
  const discovery = createAgentDiscovery({ cardRegistry: plain });
  discovery.discover({ capabilities: ["summarize"] });
  assert.equal(plain.listCalls, 1);
  const throwing = fakeRegistry();
  throwing.on = () => { throw new Error("boom"); };
  assert.doesNotThrow(() => createAgentDiscovery({ cardRegistry: throwing }));
});

test("B029-2: clearCache forces the next query to re-enumerate", () => {
  const registry = fakeRegistry();
  const discovery = createAgentDiscovery({ cardRegistry: registry });
  discovery.discover({ capabilities: ["summarize"] });
  discovery.discover({ capabilities: ["summarize"] });
  assert.equal(registry.listCalls, 1);
  discovery.clearCache();
  discovery.discover({ capabilities: ["summarize"] });
  assert.equal(registry.listCalls, 2);
});

test("B029-2: Map-shaped registries enumerate without list()", () => {
  const store = new Map([
    ["alpha", fakeCard({ agentId: "alpha", lanes: ["summarize"], version: 3 })],
  ]);
  const discovery = createAgentDiscovery({ cardRegistry: store });
  const results = discovery.discover({ capabilities: ["summarize"] });
  assert.deepEqual(results.map((r) => r.agentId), ["alpha"]);
});

test("B029-2: coded-error contract — every failure throws an Error with a code", () => {
  assertCoded(() => createAgentDiscovery(), "AD_NO_REGISTRY");
  assertCoded(() => createAgentDiscovery({ cardRegistry: null }), "AD_NO_REGISTRY");
  const discovery = createAgentDiscovery({ cardRegistry: fakeRegistry() });
  assertCoded(() => discovery.discover(null), "AD_INVALID_QUERY");
  assertCoded(() => discovery.discover("summarize"), "AD_INVALID_QUERY");
  assertCoded(() => discovery.discover({}), "AD_INVALID_QUERY");
  assertCoded(() => discovery.discover({ capabilities: [] }), "AD_INVALID_QUERY");
  assertCoded(() => discovery.discover({ capabilities: ["ok", 42] }), "AD_INVALID_QUERY");
  assertCoded(() => discovery.discover({ capabilities: ["ok"], limit: 0 }), "AD_INVALID_QUERY");
  assertCoded(() => discovery.discover({ capabilities: ["ok"], limit: 1.5 }), "AD_INVALID_QUERY");
  assertCoded(() => discovery.discover({ capabilities: ["ok"], skills: "summarize" }), "AD_INVALID_QUERY");
  const unsupported = createAgentDiscovery({ cardRegistry: {} });
  assertCoded(() => unsupported.discover({ capabilities: ["summarize"] }), "AD_REGISTRY_UNSUPPORTED");
  // Every exported error code is reachable and a string.
  assert.ok(Array.isArray(DISCOVERY_ERROR_CODES) && DISCOVERY_ERROR_CODES.length >= 4);
  for (const code of DISCOVERY_ERROR_CODES) {
    assert.equal(typeof code, "string");
    assert.match(code, /^AD_/);
  }
  // Invalid queries never count toward stats (queries = hits + misses).
  assert.deepEqual(discovery.stats(), { queries: 0, hits: 0, misses: 0 });
});
