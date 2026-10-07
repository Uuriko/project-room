import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runInThisContext } from "node:vm";
import { roomEntry, START_ROOM_URL, publicRoomDoorHtml, isPublicRoomDoorPath, wantsPublicDoorHtml, PUBLIC_DOOR_PATHS, ROOM_DEEP_LINK_SCRIPT, PUBLIC_DOOR_CSP, connectMcpPathHtml, HOSTED_MCP_JOIN_PUBLIC_URL } from "../deploy/room-entry.mjs";
import { ROOM_ORIGIN, COMPUTE_DOOR, ROOM_PUBLIC_WWW } from "../deploy/agent-discovery.mjs";

const FORBIDDEN = /Bearer |ROOM_AGENT_TOKEN|sk-|password|@gmail|John |Potter |Uuriko@|acct-|memberId":"[^c]/i;

test("Demigod HTML entry redirects to the canonical app with query preserved", async () => {
  for (const path of ["/room", "/room/", "/project-room", "/project-room/"]) {
    const response = roomEntry(new Request(`https://www.trydemigod.com${path}?start=room&room=qa&next=%2Fabout`));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), `${ROOM_ORIGIN}/?start=room&room=qa&next=%2Fabout`);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(await response.text(), "", "no pre-login wrapper copy");
  }
  const packet = roomEntry(new Request("https://www.trydemigod.com/room", {headers:{Accept:"text/plain"}}));
  assert.equal(packet.status, 200);
  assert.match(await packet.text(), /Project Room/);
});

test("entry handler leaves other Demigod pages and hosts to existing routing", () => {
  for (const path of ["/", "/hardware", "/weekly", "/ticket", "/room/api", "/contact"]) {
    assert.equal(roomEntry(new Request(`https://www.trydemigod.com${path}`)), null);
  }
  assert.equal(roomEntry(new Request("https://example.com/room")), null);
  assert.equal(roomEntry(new Request("https://www.getdasha.com/room")), null);
  assert.equal(roomEntry(new Request("https://lobby.getdasha.com/room/llms.txt")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/llms.txt")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/join.txt")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/llms-full.txt")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/skill.md")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/AGENTS.md")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/skill")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/agent.json")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/kits")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/apps")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/tools")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/mcp")), null);
  assert.equal(roomEntry(new Request("https://www.trydemigod.com/room/mcp", { method: "POST" })).status, 405);
});

test("entry supports HEAD and rejects mutations", async () => {
  assert.equal(await roomEntry(new Request("https://www.trydemigod.com/room/", { method: "HEAD" })).text(), "");
  const response = roomEntry(new Request("https://www.trydemigod.com/room", { method: "POST" }));
  assert.equal(response.status, 405); assert.equal(response.headers.get("Allow"), "GET, HEAD");
});

test("getdasha public door is a quiet Join + Connect page, not the llms packet", () => {
  assert.deepEqual([...PUBLIC_DOOR_PATHS], ["/room", "/room/"]);
  assert.equal(isPublicRoomDoorPath("/room"), true);
  assert.equal(isPublicRoomDoorPath("/room/"), true);
  assert.equal(isPublicRoomDoorPath("/"), false);
  assert.equal(isPublicRoomDoorPath("/llms.txt"), false);
  assert.equal(wantsPublicDoorHtml("text/html,application/xhtml+xml"), true);
  assert.equal(wantsPublicDoorHtml("*/*"), true);
  assert.equal(wantsPublicDoorHtml(""), true);
  assert.equal(wantsPublicDoorHtml("text/plain"), false);
  const html = publicRoomDoorHtml();
  const origin = ROOM_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(html, /<title>Project Room<\/title>/);
  assert.match(html, /A shared place for people and AI agents to build together\./);
  assert.equal([...html.matchAll(/class="lead"/g)].length, 1);
  assert.doesNotMatch(html, /href="[^" ]*\/#join\/"/);
  assert.match(html, new RegExp(`href="${origin}"`));
  assert.match(html, />Open Room</);
  // Plain-language door copy (same sentences as the Demigod entry).
  assert.match(html, /href="#join-agent"/);
  assert.match(html, />Paste a prompt</);
  assert.match(html, /id="join-agent"/);
  assert.match(html, /Join from your favorite agent app/);
  assert.match(html, /Just paste a prompt\./);
  assert.match(html, /Cursor · Grok Bot · ChatGPT · Codex · Claude · MCP/);
  assert.match(html, /id="join-prompt"/);
  assert.match(html, /<a href="\/room\/join.txt">join.txt<\/a>/);
  assert.match(html, /Add Room as MCP/);
  assert.match(html, /https:\/\/www\.getdasha\.com\/room\/mcp/);
  assert.match(html, /claude mcp add --transport http/);
  assert.doesNotMatch(html, /Join with code/);
  assert.doesNotMatch(html, /id="join-code"/);
  assert.match(html, /id="join-empty"/);
  assert.match(html, /id="join-empty-recover"/);
  assert.match(html, />Open room door</);
  assert.match(html, /href="#join-agent">Paste a prompt</);
  assert.match(html, /href="#mcp-join">Add Room as MCP</);
  assert.doesNotMatch(html, /project-room-staging\.getdasha\.workers\.dev/);
  assert.match(html, /id="connect"/);
  assert.match(html, /id="connect-title">Connect</);
  assert.match(html, /class="connect-paths"/);
  assert.match(html, />Add Room as MCP</);
  assert.match(html, new RegExp(`href="${HOSTED_MCP_JOIN_PUBLIC_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(html, /id="mcp-join-url"/);
  assert.match(html, new RegExp(`value="${HOSTED_MCP_JOIN_PUBLIC_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(html, /href="\/room\/mcp"/);
  assert.match(connectMcpPathHtml(), /Add Room as MCP/);
  assert.match(html, /Automatic replies depend on its host and connection/);
  assert.match(html, /Conversations, shared work, and a private Inbox\./);
  assert.match(html, /href="#people"/);
  assert.match(html, />People and agents</);
  assert.match(html, /id="people"/);
  assert.doesNotMatch(html, /Share <code>https:\/\/www\.getdasha\.com\/room#room\/\{roomId\}<\/code>/);
  assert.equal(ROOM_PUBLIC_WWW, "https://www.getdasha.com/room");
  assert.match(html, /Rooms are private by default\. Adding an agent never lists the room publicly\./);
  assert.doesNotMatch(html, /id="join-code"|href="#join-code"/);
  assert.match(html, /Start with a prompt/);
  assert.match(html, /<a href="\/room\/llms.txt">Read the agent packet \(llms\.txt\)<\/a>/);
  assert.equal([...html.matchAll(/href="\/room\/llms\.txt"/g)].length, 1, "llms.txt is linked once");
  assert.match(html, /<a href="\/room\/llms-full.txt">Full packet<\/a>/);
  assert.match(html, /<a href="\/room\/\.well-known\/agent\.json">Machine card \(agent\.json\)<\/a>/);
  assert.match(html, /<a href="\/room\/kits">Kits catalog<\/a>/);
  assert.doesNotMatch(html, /Agent handles stay loud|Membership and guest kit discovery|frontier member|Member\+kit/);
  assert.doesNotMatch(html, /marketplace/i);
  assert.doesNotMatch(html, /muse\.ai/i);
  assert.doesNotMatch(html, /\bAmp\b/);
  assert.doesNotMatch(html, /ChatGPT Sites|chatgpt\.com/i);
  assert.doesNotMatch(html, /pricing|per month|\$\d/i);
  assert.match(html, /Works with Claude Code, Codex, OpenCode, Cursor/);
  assert.match(html, /id="agent-type-catalog"/);
  assert.match(html, /Types for this Room only/);
  assert.match(html, /Not a public agent store/);
  assert.match(html, /data-agent-type="claude-code"/);
  assert.match(html, /href="#mcp-join"/);
  assert.match(html, /<a href="https:\/\/github\.com\/Uuriko\/project-room" rel="noopener noreferrer">github\.com\/Uuriko\/project-room<\/a>/, "source line is a real link");
  assert.match(html, new RegExp(COMPUTE_DOOR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /Compute stays separate/);
  const scriptHash = createHash("sha256").update(ROOM_DEEP_LINK_SCRIPT).digest("base64");
  assert.match(PUBLIC_DOOR_CSP, new RegExp(`script-src 'sha256-${scriptHash.replace(/[+/=]/g, "\\$&")}'`));
  assert.match(ROOM_DEEP_LINK_SCRIPT, /hashchange/);
  assert.match(ROOM_DEEP_LINK_SCRIPT, /searchParams\.set\("room"/);
  assert.match(ROOM_DEEP_LINK_SCRIPT, /click/);
  assert.match(ROOM_DEEP_LINK_SCRIPT, /location\.replace/);
  assert.doesNotMatch(html, /class="whisper join"/);
  // Start a room is the one primary action; Open signs in to an existing room.
  assert.match(html, new RegExp(`class="start" href="${START_ROOM_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">Start a room<`));
  assert.match(html, /class="ghost open"/);
  assert.match(html, /class="whisper people"/);
  assert.equal([...html.matchAll(/class="ghost[^"]*"/g)].length, 1, "Open Room is the only secondary action");
  assert.doesNotMatch(html, /href="#connect"/);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.ok(html.includes(`<script>${ROOM_DEEP_LINK_SCRIPT}</script>`));
  assert.doesNotMatch(html, /Genie/);
  assert.equal(FORBIDDEN.test(html), false);
  assert.doesNotMatch(html, /dasha\.fun|iframe|walletconnect|Bearer |ROOM_AGENT_TOKEN|# Project Room|getone\.one|Amore/i);
});

function runDoorHash(hash) {
  const hrefs = {
    "a.open": ROOM_ORIGIN,
    "a.people": "#people",
    "a.join": `${ROOM_ORIGIN}/#join/`
  };
  const node = selector => hrefs[selector] === undefined ? null : {
    getAttribute(name) { return name === "href" ? hrefs[selector] : ""; },
    setAttribute(name, value) { if (name === "href") hrefs[selector] = value; }
  };
  let replaced = "";
  const previous = {
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    addEventListener: Object.getOwnPropertyDescriptor(globalThis, "addEventListener")
  };
  Object.defineProperty(globalThis, "location", {
    configurable: true, writable: true,
    value: { hash, href: `https://www.getdasha.com/room${hash}`, replace(url) { replaced = url; } }
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true, writable: true,
    value: { querySelector: node }
  });
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true, writable: true,
    value() {}
  });
  try {
    runInThisContext(ROOM_DEEP_LINK_SCRIPT);
    return { hrefs, replaced };
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("www /room #join/<token> writes the token onto Join and leaves the wrapper", () => {
  const token = "A".repeat(43);
  const result = runDoorHash(`#join/${token}`);
  assert.equal(result.hrefs["a.join"], `${ROOM_ORIGIN}/#join/`, "no incomplete Join control is needed");
  assert.equal(result.replaced, `${ROOM_ORIGIN}/#join/${token}`);
  assert.equal(result.hrefs["a.open"], ROOM_ORIGIN);
});

test("www /room #join/<token>/work/<id> keeps the purpose path on the forwarded join", () => {
  const token = "B".repeat(43);
  const hash = `#join/${token}/work/item-1`;
  const result = runDoorHash(hash);
  assert.equal(result.hrefs["a.join"], `${ROOM_ORIGIN}/#join/`);
  assert.equal(result.replaced, `${ROOM_ORIGIN}/${hash}`);
});

test("www /room legacy #code/ links forward for app redemption", () => {
  const result = runDoorHash("#code/abc-def-ghj");
  assert.equal(result.replaced, `${ROOM_ORIGIN}/#code/abc-def-ghj`);
});

test("www /room #join/ stub does not auto-leave the wrapper", () => {
  const result = runDoorHash("#join/");
  assert.equal(result.hrefs["a.join"], `${ROOM_ORIGIN}/#join/`);
  assert.equal(result.replaced, "");
});

test("www /room short #join/ does not leave the wrapper", () => {
  const result = runDoorHash(`#join/${"x".repeat(10)}`);
  assert.equal(result.hrefs["a.join"], `${ROOM_ORIGIN}/#join/`);
  assert.equal(result.replaced, "");
});

test("www /room #room/{id} still rewrites Open/People and does not follow Join", () => {
  const result = runDoorHash("#room/commons");
  assert.equal(result.hrefs["a.open"], `${ROOM_ORIGIN}/?room=commons#room/commons`);
  assert.equal(result.hrefs["a.people"], `${ROOM_ORIGIN}/?room=commons#room/commons`);
  assert.equal(result.hrefs["a.join"], `${ROOM_ORIGIN}/#join/`);
  assert.equal(result.replaced, "");
});

test("public door pages have skip links and /room is indexable (QA4 polish)", async () => {
  const { PUBLIC_ROOM_DOOR_HTML } = await import("../deploy/room-entry.mjs");
  const html = publicRoomDoorHtml();
  for (const page of [html, PUBLIC_ROOM_DOOR_HTML]) {
    assert.match(page, /<a class="skip" href="#main">Skip to content<\/a>/);
    assert.match(page, /<main id="main">/);
  }
  // D17: the /room door is indexable.
  assert.match(PUBLIC_ROOM_DOOR_HTML, /<meta name="robots" content="index,follow">/);
});

// Primary Node boundary owner: an edge alias preserves /room before invoking
// createRoomServer, so index.html-only changes cannot satisfy this contract.
test("HTTP public doors redirect HTML, preserve query, and retain plain packets and discovery", async t => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { RoomStore } = await import("../server/store.mjs");
  const { createRoomServer } = await import("../server/http.mjs");
  const directory = mkdtempSync(join(tmpdir(), "minimal-public-entry-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({store});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory,{recursive:true,force:true}); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/room", "/room/"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${origin}${path}?start=room&room=qa&next=%2Fabout`, {method, redirect:"manual", headers:{Accept:"text/html"}});
      assert.equal(response.status,302);
      assert.equal(response.headers.get("Location"), `${origin}/?start=room&room=qa&next=%2Fabout`);
      assert.equal(await response.text(), "");
    }
    const packet = await fetch(origin+path,{headers:{Accept:"text/plain"}});
    assert.equal(packet.status,200);
    assert.match(packet.headers.get("Content-Type"), /text\/plain/);
    assert.match(await packet.text(), /Project Room/);
  }
  const packet = await fetch(origin+"/room/llms.txt");
  assert.equal(packet.status,200);
  assert.match(await packet.text(), /Project Room/);
  const mutation = await fetch(origin+"/room",{method:"POST"});
  assert.equal(mutation.status,405);
});
