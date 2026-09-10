import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { roomEntry } from "../deploy/room-entry.mjs";
import { agentCard, llmsTxt, agentCardJson, discoveryDoc, DISCOVERY_PATHS, ROOM_ORIGIN, ROOM_DOOR, ROOM_DOCS } from "../deploy/agent-discovery.mjs";

const FORBIDDEN = /Bearer |ROOM_AGENT_TOKEN|sk-|password|@gmail|John |Potter |Uuriko@|acct-|memberId":"[^c]/i;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-discovery-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("discovery documents name origin, door, three join tiers and first tools without secrets", () => {
  const card = agentCard(), text = llmsTxt();
  assert.equal(card.url, ROOM_ORIGIN);
  assert.equal(card.door, ROOM_DOOR);
  assert.deepEqual(card.join.map(row => row.id), ["packet", "guest-agent-link", "enrolled-key"]);
  assert.equal(card.join.find(row => row.id === "packet").status, "live");
  assert.equal(card.join.find(row => row.id === "guest-agent-link").status, "designed");
  assert.equal(card.join.find(row => row.id === "enrolled-key").status, "live");
  assert.deepEqual(card.firstTools.map(row => row.name), ["room_check_access", "orient"]);
  assert.equal(card.capabilities.remoteMcp, false);
  assert.equal(card.capabilities.guestAgentLinkMint, false);
  assert.match(text, /packet \(live, no account\)/);
  assert.match(text, /guest-agent-link \(designed, not live\)/);
  assert.match(text, /room_check_access/);
  assert.match(text, /orient/);
  assert.match(text, new RegExp(ROOM_DOCS.client.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(FORBIDDEN.test(text), false);
  assert.equal(FORBIDDEN.test(agentCardJson()), false);
  assert.equal(JSON.parse(agentCardJson()).protocol, "project-room-discovery");
});

test("Room Worker serves /llms.txt and /.well-known/agent.json", async t => {
  const origin = await serve(t);
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
});

test("door serves the same discovery bytes and points at origin", async () => {
  const html = await roomEntry(new Request("https://www.trydemigod.com/room")).text();
  assert.match(html, /chat packet/);
  assert.match(html, /href="\/room\/llms.txt"/);
  assert.match(html, new RegExp(`${ROOM_ORIGIN.replace(/[./]/g, "\\$&")}/\\.well-known/agent\\.json`));
  for (const [doorPath, originPath] of [["/room/llms.txt", "/llms.txt"], ["/room/.well-known/agent.json", "/.well-known/agent.json"],
    ["/project-room/llms.txt", "/llms.txt"], ["/project-room/.well-known/agent.json", "/.well-known/agent.json"]]) {
    const expected = discoveryDoc(originPath);
    const get = roomEntry(new Request(`https://www.trydemigod.com${doorPath}`));
    assert.equal(get.status, 200, doorPath);
    assert.equal(get.headers.get("content-type"), expected.type);
    assert.equal(await get.text(), expected.body);
    assert.equal(await roomEntry(new Request(`https://www.trydemigod.com${doorPath}`, { method: "HEAD" })).text(), "");
    assert.equal(roomEntry(new Request(`https://www.trydemigod.com${doorPath}`, { method: "POST" })).status, 405);
  }
});
