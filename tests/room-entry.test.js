import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { roomEntry, publicRoomDoorHtml, isPublicRoomDoorPath, wantsPublicDoorHtml, PUBLIC_DOOR_PATHS, ROOM_DEEP_LINK_SCRIPT, PUBLIC_DOOR_CSP, publicDoorHashForward, connectMcpPathHtml, HOSTED_MCP_JOIN_PUBLIC_URL } from "../deploy/room-entry.mjs";
import { COMPUTE_DOOR, ROOM_PUBLIC_WWW, BROWSER_ROOM_PATH } from "../deploy/agent-discovery.mjs";

const FORBIDDEN = /Bearer |ROOM_AGENT_TOKEN|sk-|password|@gmail|John |Potter |Uuriko@|acct-|memberId":"[^c]/i;

test("unlisted entry opens the isolated Room without forwarding input or embedding credentials", async () => {
  const response = roomEntry(new Request("https://www.trydemigod.com/room?return=untrusted"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  const html = await response.text();
  assert.match(html, /href="https:\/\/www\.getdasha\.com\/room"/);
  assert.doesNotMatch(html, /project-room-staging\.getdasha\.workers\.dev/);
  assert.match(html, /--ink:#0B120F/);
  assert.match(html, /href="\/contact"/);
  assert.match(html, /Paste your room key/);
  // Plain-language door copy: first-time visitors should not need to decode shorthand.
  assert.match(html, /Joining as a person or an agent is free\./);
  assert.match(html, /href="#join-agent"/);
  assert.match(html, />Paste a prompt</);
  assert.match(html, /Join from your favorite agent app/);
  assert.match(html, /Just paste a prompt\./);
  assert.match(html, /Cursor · Grok Bot · ChatGPT · Codex · Claude · MCP/);
  assert.match(html, /id="join-prompt"/);
  assert.match(html, /<a href="\/room\/join.txt">join.txt<\/a>/);
  assert.match(html, /Add Room as MCP/);
  assert.match(html, /https:\/\/www\.getdasha\.com\/room\/mcp/);
  assert.match(html, /claude mcp add --transport http/);
  assert.match(html, /Join with code/);
  assert.match(html, /ABC-DEF-GHJ/);
  assert.match(html, /Connect an agent/);
  assert.match(html, /Invite teammates and AI agents to work on the same items together\./);
  assert.match(html, /Rooms are private by default\. Adding an agent never lists the room publicly\./);
  assert.match(html, /Agents keep a visible @handle, and finished work lands as a receipt\./);
  assert.match(html, /your Second \/ their agents \/ one Room/);
  assert.match(html, /<strong>Create Room<\/strong>/);
  assert.match(html, /bootstrap-agent-room/);
  assert.match(html, /POST \/room\/api\/agent-rooms/);
  assert.match(html, /kind: personal\|organization/);
  assert.match(html, /<strong>Invite agents<\/strong>/);
  assert.match(html, /invite_member/);
  assert.match(html, /collaborate\/contribute/);
  assert.match(html, /Wake, Pull, Desktop, and Takeover/);
  assert.doesNotMatch(html, /Genie/);
  assert.match(html, /<strong>Paste the packet<\/strong>/);
  assert.match(html, /<strong>Guest agent<\/strong>/);
  assert.match(html, /<strong>Add agent<\/strong>/);
  assert.match(html, /Never paste a room key into a chat\./);
  assert.match(html, /short-lived guest agent link \(it starts with <code>ga1\.<\/code>\)/);
  assert.match(html, /enrolls a lasting agent with its own key\./);
  assert.match(html, /Connect tools as separate agents — one to research, one to edit, one to plan/);
  assert.match(html, /Planning agents propose; working agents do; a mid-task steer becomes a handoff note, not a cancellation\./);
  assert.match(html, /Works with Claude Code, Codex, OpenCode, Cursor/);
  assert.match(html, /id="agent-type-catalog"/);
  assert.match(html, /Types for this Room only/);
  assert.match(html, /Not a public agent store/);
  assert.match(html, /data-agent-type="claude-code"/);
  assert.match(html, /data-agent-type="hermes"/);
  assert.match(html, /data-join-path="mcp-url"/);
  // One packet link plus the distinct discovery documents; no duplicate labels for the same URL.
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
  assert.doesNotMatch(html, /\$|pricing|per month|credit/i);
  assert.match(html, /<a href="https:\/\/github\.com\/Uuriko\/project-room" rel="noopener noreferrer">github\.com\/Uuriko\/project-room<\/a>/, "source line is a real link");
  assert.ok(!html.includes("untrusted"));
  assert.ok(!html.includes("<script"));
  assert.doesNotMatch(html, /dasha\.fun|iframe|walletconnect|Bearer |ROOM_AGENT_TOKEN/i);
  assert.doesNotMatch(html, /Genie/);
});

test("/project-room is the same noindex landing", async () => {
  const response = roomEntry(new Request("https://www.trydemigod.com/project-room"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(await response.text(), /Open Project Room/);
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
  assert.match(html, /<title>Project Room<\/title>/);
  assert.match(html, /Work Items, next actions, receipts\. Agents are Members\./);
  assert.equal([...html.matchAll(/class="lead"/g)].length, 1);
  assert.match(html, /class="join-note"/);
  assert.match(html, new RegExp(`href="${BROWSER_ROOM_PATH}"`));
  assert.match(html, />Open</);
  assert.match(html, new RegExp(`href="${BROWSER_ROOM_PATH}/#join/"`));
  assert.match(html, />Join</);
  assert.doesNotMatch(html, /project-room-staging\.getdasha\.workers\.dev/);
  assert.match(html, /data-room-origin="\/room"/);
  assert.match(html, /id="join-empty"/);
  assert.match(html, /This invite link is incomplete/);
  // Plain-language door copy (same sentences as the Demigod entry).
  assert.match(html, /Joining as a person or an agent is free\./);
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
  assert.match(html, /Join with code/);
  assert.match(html, /id="join-code"/);
  assert.match(html, /class="whisper"[^>]*href="#join-code"/);
  assert.match(html, /id="connect"/);
  assert.match(html, /id="connect-title">Connect</);
  assert.match(html, /class="connect-paths"/);
  assert.match(html, />Add Room as MCP</);
  assert.match(html, new RegExp(`href="${HOSTED_MCP_JOIN_PUBLIC_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(html, /id="mcp-join-url"/);
  assert.match(html, new RegExp(`value="${HOSTED_MCP_JOIN_PUBLIC_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(html, /GET snippets\. No OAuth\. No keys\./);
  assert.match(html, /href="\/room\/mcp"/);
  assert.match(connectMcpPathHtml(), /Add Room as MCP/);
  assert.match(connectMcpPathHtml(), /No OAuth/);
  assert.match(html, /Invite-code \(RM-\)/);
  assert.match(html, /@mention uses Connect Wake\/Pull once Quill's RC-051 lands/);
  assert.match(html, /your Second \/ their agents \/ one Room/);
  assert.match(html, /href="#people"/);
  assert.match(html, />People</);
  assert.match(html, /id="people"/);
  assert.match(html, /Open this invite link to join as a person/);
  assert.match(html, /Open and People honor <code>#room\/\{roomId\}<\/code> for members already in the room/);
  assert.match(html, /that is not a shareable invite/);
  assert.doesNotMatch(html, /Share <code>https:\/\/www\.getdasha\.com\/room#room\/\{roomId\}<\/code>/);
  assert.equal(ROOM_PUBLIC_WWW, "https://www.getdasha.com/room");
  assert.match(html, /Invite teammates and AI agents to work on the same items together\./);
  assert.match(html, /Rooms are private by default\. Adding an agent never lists the room publicly\./);
  assert.match(html, /Agents keep a visible @handle, and finished work lands as a receipt\./);
  assert.match(html, /<strong>Create Room<\/strong>/);
  assert.match(html, /bootstrap-agent-room/);
  assert.match(html, /POST \/room\/api\/agent-rooms/);
  assert.match(html, /kind: personal\|organization/);
  assert.match(html, /<strong>Invite agents<\/strong>/);
  assert.match(html, /invite_member/);
  assert.match(html, /collaborate\/contribute/);
  assert.match(html, /<strong>Paste the packet<\/strong>/);
  assert.match(html, /<strong>Guest agent<\/strong>/);
  assert.match(html, /short-lived guest agent link \(it starts with <code>ga1\.<\/code>\)/);
  assert.match(html, /<strong>Add agent<\/strong>/);
  assert.match(html, /enrolls a lasting agent with its own key\./);
  assert.match(html, /<strong>Kits<\/strong> — Members can attach a kit/);
  assert.match(html, /Wake, Pull, Desktop, and Takeover/);
  assert.match(html, /Connect tools as separate agents — one to research, one to edit, one to plan/);
  assert.match(html, /Planning agents propose; working agents do; a mid-task steer becomes a handoff note, not a cancellation\./);
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
  assert.match(html, /--ink:#070608/);
  assert.match(html, /--acid:#dfff00/);
  const scriptHash = createHash("sha256").update(ROOM_DEEP_LINK_SCRIPT).digest("base64");
  assert.match(PUBLIC_DOOR_CSP, new RegExp(`script-src 'sha256-${scriptHash.replace(/[+/=]/g, "\\$&")}'`));
  assert.match(ROOM_DEEP_LINK_SCRIPT, /hashchange/);
  assert.match(ROOM_DEEP_LINK_SCRIPT, /searchParams\.set\("room"/);
  assert.match(ROOM_DEEP_LINK_SCRIPT, /click/);
  assert.match(ROOM_DEEP_LINK_SCRIPT, /location\.replace/);
  assert.match(html, /class="ghost join"/);
  assert.match(html, /class="whisper people"/);
  assert.equal([...html.matchAll(/class="ghost[^"]*"/g)].length, 1, "Join is the only ghost CTA");
  assert.doesNotMatch(html, /href="#connect"/);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.ok(html.includes(`<script>${ROOM_DEEP_LINK_SCRIPT}</script>`));
  assert.doesNotMatch(html, /Genie/);
  assert.equal(FORBIDDEN.test(html), false);
  assert.doesNotMatch(html, /dasha\.fun|iframe|walletconnect|Bearer |ROOM_AGENT_TOKEN|# Project Room|getone\.one|Amore/i);
});

function runDoorHash(hash) {
  const hrefs = {
    "a.open": BROWSER_ROOM_PATH,
    "a.people": "#people",
    "a.join": `${BROWSER_ROOM_PATH}/#join/`
  };
  const empty = { hidden: true };
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
    value: {
      querySelector: node,
      getElementById(id) {
        if (id !== "join-empty") return null;
        return {
          removeAttribute(name) { if (name === "hidden") empty.hidden = false; },
          setAttribute(name, value) { if (name === "hidden") empty.hidden = value !== null; }
        };
      }
    }
  });
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true, writable: true,
    value() {}
  });
  try {
    publicDoorHashForward();
    return { hrefs, replaced, emptyShown: !empty.hidden };
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("www /room #join/<token> writes the token onto Join and stays on /room", () => {
  const token = "A".repeat(43);
  const result = runDoorHash(`#join/${token}`);
  assert.equal(result.hrefs["a.join"], `https://www.getdasha.com/room/#join/${token}`);
  assert.equal(result.replaced, `https://www.getdasha.com/room/#join/${token}`);
  assert.equal(result.hrefs["a.open"], BROWSER_ROOM_PATH);
  assert.equal(result.emptyShown, false);
});

test("www /room #join/<token>/work/<id> keeps the purpose path on the forwarded join", () => {
  const token = "B".repeat(43);
  const hash = `#join/${token}/work/item-1`;
  const result = runDoorHash(hash);
  assert.equal(result.hrefs["a.join"], `https://www.getdasha.com/room/${hash}`);
  assert.equal(result.replaced, `https://www.getdasha.com/room/${hash}`);
});

test("www /room #code/ABC-DEF-GHJ writes the short code onto Join and stays on /room", () => {
  const result = runDoorHash("#code/abc-def-ghj");
  assert.equal(result.hrefs["a.join"], "https://www.getdasha.com/room/#code/ABC-DEF-GHJ");
  assert.equal(result.replaced, "https://www.getdasha.com/room/#code/ABC-DEF-GHJ");
});

test("www /room #join/ stub shows an empty-state whisper and does not auto-leave", () => {
  const result = runDoorHash("#join/");
  assert.equal(result.hrefs["a.join"], `${BROWSER_ROOM_PATH}/#join/`);
  assert.equal(result.replaced, "");
  assert.equal(result.emptyShown, true);
});

test("www /room #join/too-short shows the incomplete-invite whisper", () => {
  const result = runDoorHash("#join/abc");
  assert.equal(result.replaced, "");
  assert.equal(result.emptyShown, true);
});

test("www /room #room/{id} still rewrites Open/People and does not follow Join", () => {
  const result = runDoorHash("#room/commons");
  assert.equal(result.hrefs["a.open"], "https://www.getdasha.com/room?room=commons#room/commons");
  assert.equal(result.hrefs["a.people"], "https://www.getdasha.com/room?room=commons#room/commons");
  assert.equal(result.hrefs["a.join"], `${BROWSER_ROOM_PATH}/#join/`);
  assert.equal(result.replaced, "");
  assert.equal(result.emptyShown, false);
});

test("door script bytes are the exported hash-forward function", () => {
  assert.equal(ROOM_DEEP_LINK_SCRIPT, `(${publicDoorHashForward.toString()})();`);
});
