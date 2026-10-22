// Specimen for the one-paste connect skill (2026-10-19 slice 1, chartered
// as BUILD-CONNECT-SKILL after U-04 verified the namespace 404ing live).
// The skill's body is generated from the live discovery inventory; this
// specimen executes the served bytes end-to-end and resolves EVERY route
// the skill names against the server's own inventories (route table,
// discovery inventory, legacy allowlist, discovery doc paths), so a route
// rename anywhere fails here instead of stranding a cold agent.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { discoveryDoc, DISCOVERY_PATHS, ROOM_ORIGIN } from "../server/agent-discovery.mjs";
import { CONNECT_SKILL_PATH, AGENT_SKILLS_INDEX_PATH, CONNECT_PROTOCOL_ROUTES, connectSkillMd, agentSkillsIndexJson } from "../server/connect-skill.mjs";
import { DISCOVERABILITY_ROUTES } from "../server/discoverability.mjs";
import { ROUTES } from "../server/routes/table.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const readRepo = rel => readFileSync(join(repoRoot, rel), "utf8");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-connect-skill-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

// Every "METHOD /path" the skill teaches, as written in its code blocks and
// inline route references (origin-prefixed or bare).
function namedRoutes(markdown) {
  const found = new Map();
  const pattern = /\b(GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/[^\s`"']+?)?(\/[^\s`"']*)/g;
  for (const match of markdown.matchAll(pattern)) {
    const path = match[2].replace(/[.,;]+$/, "");
    found.set(`${match[1]} ${path}`, { method: match[1], path });
  }
  return [...found.values()];
}

// The union of route inventories the server itself maintains. A route the
// skill names must live in at least one of them, with a matching method.
function liveRouteIndex() {
  const index = new Map();
  const add = (method, path) => {
    const key = path.replace(/\{[^}]+\}/g, "{}");
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(method);
  };
  for (const row of ROUTES) add(row.method, row.path);
  for (const entry of DISCOVERABILITY_ROUTES) for (const method of entry.methods) add(method, entry.path);
  const allowlist = JSON.parse(readRepo("scripts/routes-legacy-allowlist.json"));
  for (const section of ["baseline", "routes"]) {
    for (const row of allowlist[section]) { add(row.method, row.path); add("GET", row.path); }
  }
  for (const path of DISCOVERY_PATHS) add("GET", path);
  return index;
}

test("the served connect skill fetches 200 as markdown and parses as a skill file", async t => {
  const base = await serve(t);
  const res = await fetch(`${base}${CONNECT_SKILL_PATH}`, { headers: { "User-Agent": "project-room-agent" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
  const body = await res.text();
  assert.equal(body, connectSkillMd(), "the served bytes are the generated body");
  const frontmatter = body.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, "skill file opens with YAML frontmatter");
  assert.match(frontmatter[1], /^name:\s*\S+/m, "frontmatter names the skill");
  assert.match(frontmatter[1], /^description:\s*\S+/m, "frontmatter describes the skill");
});

test("the agent-skills index fetches 200 and points at the served skill", async t => {
  const base = await serve(t);
  const res = await fetch(`${base}${AGENT_SKILLS_INDEX_PATH}`, { headers: { "User-Agent": "project-room-agent" } });
  assert.equal(res.status, 200);
  const index = JSON.parse(await res.text());
  assert.equal(index.skills.length, 1);
  assert.equal(index.skills[0].name, "connect");
  assert.equal(index.skills[0].url, `${ROOM_ORIGIN}${CONNECT_SKILL_PATH}`);
  assert.equal(agentSkillsIndexJson(), JSON.stringify(index, null, 2));
  assert.equal(discoveryDoc(AGENT_SKILLS_INDEX_PATH)?.type, "application/json; charset=utf-8");
});

test("every route the connect skill names resolves against the live route inventories", () => {
  const index = liveRouteIndex();
  const routes = namedRoutes(connectSkillMd());
  assert.ok(routes.length >= 6, `skill names ${routes.length} routes, expected at least 6`);
  for (const { method, path } of routes) {
    const methods = index.get(path.replace(/\{[^}]+\}/g, "{}"));
    assert.ok(methods, `skill names ${method} ${path}, which no live inventory carries`);
    assert.ok(methods.has(method), `skill names ${method} ${path}, but the live inventories carry only ${[...methods].join("/")}`);
  }
});

test("the pinned wake-protocol legs still match the dispatch source and the legacy allowlist", () => {
  const dispatch = readRepo("server/agent-plugin-routes.mjs");
  const allowlist = JSON.parse(readRepo("scripts/routes-legacy-allowlist.json"));
  const allowed = new Set(allowlist.routes.map(row => `${row.method} ${row.path}`));
  for (const leg of CONNECT_PROTOCOL_ROUTES) {
    assert.ok(dispatch.includes(`method: "${leg.method}", path: "${leg.path}"`),
      `${leg.method} ${leg.path} is no longer an agent-plugin-routes action row`);
    assert.ok(dispatch.includes(`pathname === "${leg.path}" && method === "${leg.method}"`),
      `${leg.method} ${leg.path} is no longer dispatched in agent-plugin-routes.mjs`);
    assert.ok(allowed.has(`${leg.method} ${leg.path}`), `${leg.method} ${leg.path} left the legacy allowlist`);
  }
});

test("the MCP tool the skill names for saying hello exists in the catalog snapshot", () => {
  const body = connectSkillMd();
  const snapshot = JSON.parse(readRepo("tests/fixtures/mcp-catalog.snapshot.json"));
  const toolNames = new Set(Object.values(snapshot).flatMap(section => Object.keys(section)));
  for (const match of body.matchAll(/`(room_[a-z_]+)`/g)) {
    assert.ok(toolNames.has(match[1]), `skill names MCP tool ${match[1]}, absent from the catalog snapshot`);
  }
});

test("the credential field the skill prose names is the one the redeem response carries, and it authenticates", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-connect-skill-pin-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "User-Agent": "project-room-agent", "Content-Type": "application/json", Origin: base };

  // The one-time credential field Step 1's prose names.
  const named = connectSkillMd().match(/one-time `([A-Za-z]+)`/);
  assert.ok(named, "the skill's Step 1 prose names a one-time credential field");
  const field = named[1];

  const mint = await fetch(`${base}/api/rooms/commons/agent-invites`, {
    method: "POST", headers: { ...headers, Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ permissions: ["accept_work"], expiresInMinutes: 60, displayName: "Pin Bot" })
  });
  assert.equal(mint.status, 201, "operator-side mint succeeds");
  const { code } = await mint.json();

  const redeem = await fetch(`${base}/api/agent-invites/redeem`, {
    method: "POST", headers, body: JSON.stringify({ code, displayName: "Pin Bot" })
  });
  assert.equal(redeem.status, 201, "redeem as documented succeeds");
  const response = await redeem.json();

  // Exactly one secret-shaped field rides the response, and the prose names
  // it (D1: the prose named `secret`; the response carries `identitySecret`,
  // and Step 2 read from the named field returned 401).
  const secretFields = Object.keys(response).filter(key => /secret/i.test(key));
  assert.deepEqual(secretFields, [field],
    `redeem response carries secret-shaped fields [${secretFields.join(", ")}] but the skill names ${field}`);
  assert.equal(typeof response[field], "string");
  assert.ok(response[field].length > 0, "the named field carries the credential value");

  // Step 2 as documented, with the value from the prose-named field.
  const heartbeat = await fetch(`${base}/api/agent-heartbeats`, {
    method: "POST", headers: { ...headers, Authorization: `Bearer ${response[field]}` },
    body: JSON.stringify({ hostId: "pin-host", mode: "wakeable" })
  });
  assert.equal(heartbeat.status, 200, "heartbeat with the prose-named field's value succeeds");
});

test("the connect skill copy makes no pay or payout claim", () => {
  const body = connectSkillMd();
  assert.doesNotMatch(body, /get paid|start earning|earn money|payout path exists/i);
  assert.match(body, /not cash/, "the skill states the ledger-units truth");
});
