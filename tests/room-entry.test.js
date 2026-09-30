import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { roomEntry, START_ROOM_URL, publicRoomDoorHtml, isPublicRoomDoorPath, wantsPublicDoorHtml, PUBLIC_DOOR_PATHS, ROOM_DEEP_LINK_SCRIPT, PUBLIC_DOOR_CSP, publicDoorHashForward, connectMcpPathHtml, HOSTED_MCP_JOIN_PUBLIC_URL } from "../deploy/room-entry.mjs";
import { ROOM_ORIGIN, COMPUTE_DOOR, ROOM_PUBLIC_WWW } from "../deploy/agent-discovery.mjs";
import { parseShareInviteCode } from "../src/share-invite-code.js";

const FORBIDDEN = /Bearer |ROOM_AGENT_TOKEN|sk-|password|@gmail|John |Potter |Uuriko@|acct-|memberId":"[^c]/i;

test("unlisted entry opens the isolated Room without forwarding input or embedding credentials", async () => {
  const response = roomEntry(new Request("https://www.trydemigod.com/room?return=untrusted"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  const html = await response.text();
  assert.match(html, /href="https:\/\/room.trydemigod.com"/);
  assert.match(html, /--ink:#0B120F/);
  assert.match(html, /href="\/contact"/);
  assert.match(html, new RegExp(`class="open" href="${START_ROOM_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">Start a room<`));
  assert.match(html, /Open Project Room/);
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
  assert.match(html, /Conversations, shared work, and a private Inbox\./);
  assert.match(html, /<strong>Create Room<\/strong>/);
  assert.match(html, /bootstrap-agent-room/);
  assert.match(html, /local-only/);
  assert.match(html, /no <code>POST \/api\/bootstrap-agent-room<\/code>/);
  assert.doesNotMatch(html, /project-room-staging\.getdasha\.workers\.dev/);
  assert.match(html, /POST \/room\/api\/agent-rooms/);
  assert.match(html, /kind: personal\|organization/);
  assert.match(html, /<strong>Invite agents<\/strong>/);
  assert.match(html, /invite_member/);
  assert.match(html, /collaborate\/contribute/);
  assert.match(html, /Start with a prompt/);
  assert.doesNotMatch(html, /Genie/);
  assert.match(html, /<strong>Paste the packet<\/strong>/);
  assert.match(html, /<strong>Guest invite<\/strong>/);
  assert.match(html, /<strong>Add agent<\/strong>/);
  assert.match(html, /Never paste a room key into a chat\./);
  assert.match(html, /The room owner issues a short-lived guest invite for a one-off helper\./);
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
  const origin = ROOM_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(html, /<title>Project Room<\/title>/);
  assert.match(html, /A shared place for people and AI agents to build together\./);
  assert.equal([...html.matchAll(/class="lead"/g)].length, 1);
  assert.match(html, /class="join-note"/);
  assert.match(html, new RegExp(`href="${origin}"`));
  assert.match(html, />Open</);
  assert.match(html, new RegExp(`href="${origin}/#join/"`));
  assert.match(html, />Join</);
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
  assert.match(html, /id="join-empty"/);
  assert.match(html, /id="join-empty-recover"/);
  assert.match(html, />Open room door</);
  assert.match(html, /href="#join-code">Join with code</);
  assert.match(html, /href="#join-agent">Paste a prompt</);
  assert.match(html, /href="#mcp-join">Add Room as MCP</);
  assert.match(html, /id="join-code-status"/);
  assert.doesNotMatch(html, /project-room-staging\.getdasha\.workers\.dev/);
  assert.match(html, new RegExp(`data-room-origin="${origin}"`));
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
  assert.match(html, /<strong>Invite code<\/strong>/);
  assert.match(html, /Automatic replies depend on its host and connection/);
  assert.match(html, /Conversations, shared work, and a private Inbox\./);
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
  assert.match(html, /local-only/);
  assert.match(html, /no <code>POST \/api\/bootstrap-agent-room<\/code>/);
  assert.doesNotMatch(html, /project-room-staging\.getdasha\.workers\.dev/);
  assert.match(html, /POST \/room\/api\/agent-rooms/);
  assert.match(html, /kind: personal\|organization/);
  assert.match(html, /<strong>Invite agents<\/strong>/);
  assert.match(html, /invite_member/);
  assert.match(html, /collaborate\/contribute/);
  assert.match(html, /<strong>Paste the packet<\/strong>/);
  assert.match(html, /<strong>Guest invite<\/strong>/);
  assert.match(html, /The room owner issues a short-lived guest invite for a one-off helper\./);
  assert.match(html, /<strong>Add agent<\/strong>/);
  assert.match(html, /enrolls a lasting agent with its own key\./);
  assert.match(html, /<strong>Kits<\/strong> — Members can attach a kit/);
  assert.match(html, /Start with a prompt/);
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
  assert.match(html, /class="whisper join"/);
  // Start a room is the one primary action; Open signs in to an existing room.
  assert.match(html, new RegExp(`class="start" href="${START_ROOM_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">Start a room<`));
  assert.match(html, /class="ghost open"/);
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
    publicDoorHashForward();
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
  assert.equal(result.hrefs["a.join"], `${ROOM_ORIGIN}/#join/${token}`);
  assert.equal(result.replaced, `${ROOM_ORIGIN}/#join/${token}`);
  assert.equal(result.hrefs["a.open"], ROOM_ORIGIN);
});

test("www /room #join/<token>/work/<id> keeps the purpose path on the forwarded join", () => {
  const token = "B".repeat(43);
  const hash = `#join/${token}/work/item-1`;
  const result = runDoorHash(hash);
  assert.equal(result.hrefs["a.join"], `${ROOM_ORIGIN}/${hash}`);
  assert.equal(result.replaced, `${ROOM_ORIGIN}/${hash}`);
});

test("www /room #code/ABC-DEF-GHJ stays on the door instead of a silent leave", () => {
  const result = runDoorHash("#code/abc-def-ghj");
  assert.equal(result.hrefs["a.join"], `${ROOM_ORIGIN}/#join/`);
  assert.equal(result.replaced, "");
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

test("door script bytes are the exported hash-forward function", () => {
  assert.equal(ROOM_DEEP_LINK_SCRIPT, `(${publicDoorHashForward.toString()})();`);
});

// Join-with-code submit harness: the real publicDoorHashForward runs against
// stub DOM nodes, a controllable fetch, and stub timers. The stubs are dumb
// recorders — every behavior under test (message copy, busy state, fetch
// URL/body, navigation) comes from the production script, never the stub.
const JOIN_CODE_FORMAT_MESSAGE = "That isn't a join code. Use ABC-DEF-GHJ (9 characters).";
const JOIN_CODE_INVALID_MESSAGE = "This invite link is invalid, already used, or expired. Ask the inviter for a fresh link.";
const JOIN_CODE_PREVIEW_PATH = "https://www.getdasha.com/room/api/share-links/preview";

function deferredFetch() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const impl = (url, options) => { impl.calls.push({ url, options }); return promise; };
  impl.calls = [];
  impl.resolve = resolve;
  impl.reject = reject;
  impl.promise = promise;
  return impl;
}

function runDoorSubmit({ hash = "", inputValue = "", fetchImpl = null, formOrigin = ROOM_ORIGIN } = {}) {
  const calls = { assigned: [], timerCleared: false, focused: false };
  const statusEl = {
    textContent: "", hidden: true,
    removeAttribute(name) { if (name === "hidden") this.hidden = false; },
    setAttribute(name) { if (name === "hidden") this.hidden = true; }
  };
  const joinEmptyMessage = { textContent: "" };
  const joinEmptyEl = {
    hidden: true,
    querySelector(sel) { return sel === "#join-empty-message" ? joinEmptyMessage : null; },
    removeAttribute(name) { if (name === "hidden") this.hidden = false; },
    setAttribute(name) { if (name === "hidden") this.hidden = true; }
  };
  const inputEl = {
    value: inputValue, disabled: false, attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    focus() { calls.focused = true; }
  };
  const buttonEl = { disabled: false, textContent: "Join with code" };
  const formEl = {
    id: "join-code-form",
    getAttribute(name) { return name === "data-room-origin" ? formOrigin : null; }
  };
  const listeners = {};
  let timerFn = null;
  const timerHandle = { unref() { return timerHandle; } };
  const keys = ["location", "document", "addEventListener", "fetch", "setTimeout", "clearTimeout"];
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const locationStub = {
    hash, href: `https://www.getdasha.com/room${hash}`,
    assign(url) { calls.assigned.push(url); }
  };
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: locationStub });
  Object.defineProperty(globalThis, "document", {
    configurable: true, writable: true,
    value: {
      querySelector(selector) {
        return { "#join-code-status": statusEl, "#join-code": inputEl,
          "#join-code-submit": buttonEl, "#join-code-form": formEl }[selector] ?? null;
      },
      getElementById(id) {
        return { "join-code-status": statusEl, "join-empty": joinEmptyEl }[id] ?? null;
      },
      addEventListener(type, fn) { listeners[type] = fn; }
    }
  });
  Object.defineProperty(globalThis, "addEventListener", { configurable: true, writable: true, value() {} });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true, writable: true,
    value: fetchImpl ?? (() => { throw new Error("fetch must not be called for this input"); })
  });
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true, writable: true, value(fn) { timerFn = fn; return timerHandle; }
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true, writable: true, value() { calls.timerCleared = true; }
  });
  const restore = () => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  publicDoorHashForward();
  return {
    calls, statusEl, joinEmptyMessage, joinEmptyEl, inputEl, buttonEl, formEl, locationStub, restore,
    fireTimer() { if (timerFn && !calls.timerCleared) timerFn(); },
    dispatchSubmit() { listeners.submit({ target: formEl, preventDefault() {} }); }
  };
}

test("door formatCode agrees with the canonical parser on every input", () => {
  // The door embeds its own copy of the short-code parser (CSP forbids
  // importing the module). Any drift — alphabet, folding, separators,
  // grouping — false-rejects real codes or accepts agent codes. The
  // battery pins the verdict agreement, including the two historical
  // drift shapes: group structure (canonical ignores it) and tab
  // separators (canonical rejects them).
  const inputs = [
    "ABC-DEF-GHJ", "abc-def-ghj", "ABCDEFGHI", "AB-CD-EFGHJ",
    "abc def ghj", "ABC_DEF_GHJ", "aBc-dEf-GhJ", "012-345-678", "019-234-567",
    "ABC-DEF-GHJ ", "ABC-DEF-GHJ".toLowerCase().replace(/-/g, "  "),
    // BOG-USC-ODE: malformed — Crockford base32 has no U (and O folds to 0).
    "BOG-USC-ODE", "BOGUS", "BOGUS!!!", "ABCDEFGHIJ", "ABC-DEF-GH", "RM-AAAAAAAAAAAAAAAA",
    "", "   ", "ABC-DEF-GH\tJ", "ABC-DEF-GH\nJ", "ABC-DEF-GHJ-EXTRA",
    "AB CD EF GH IJ", "!@#-DEF-GHJ"
  ];
  for (const input of inputs) {
    const canonical = parseShareInviteCode(input);
    const fetchImpl = deferredFetch();
    const t = runDoorSubmit({ inputValue: input, fetchImpl });
    try {
      t.dispatchSubmit();
      if (canonical) {
        assert.equal(fetchImpl.calls.length, 1, `${JSON.stringify(input)}: canonical accepts, door must attempt the preview`);
        assert.equal(fetchImpl.calls[0].url, JOIN_CODE_PREVIEW_PATH);
        assert.equal(fetchImpl.calls[0].options.method, "POST");
        assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), { linkToken: canonical });
      } else {
        assert.equal(fetchImpl.calls.length, 0, `${JSON.stringify(input)}: canonical rejects, door must not fetch`);
        assert.equal(t.statusEl.textContent, JOIN_CODE_FORMAT_MESSAGE);
        assert.equal(t.statusEl.hidden, false);
      }
    } finally {
      t.restore();
    }
  }
});

test("join-code submit: malformed input teaches inline, never silently no-ops", () => {
  const t = runDoorSubmit({ inputValue: "BOGUS!" });
  try {
    t.dispatchSubmit();
    // fetch would throw synchronously if called — reaching here proves silence is gone.
    assert.equal(t.statusEl.textContent, JOIN_CODE_FORMAT_MESSAGE);
    assert.equal(t.statusEl.hidden, false);
    assert.equal(t.joinEmptyMessage.textContent, JOIN_CODE_FORMAT_MESSAGE);
    assert.equal(t.inputEl.attrs["aria-invalid"], "true");
    assert.equal(t.calls.focused, true);
    assert.equal(t.calls.assigned.length, 0);
  } finally {
    t.restore();
  }
});

test("join-code submit: well-formed unknown code shows the invalid/expired message", async () => {
  // The reported bug: a well-formed code that is not a live invite failed
  // silently. (BOG-USC-ODE from the QA report is malformed — Crockford
  // base32 has no U — so it correctly gets the format lesson instead.)
  const fetchImpl = deferredFetch();
  const t = runDoorSubmit({ inputValue: "ABC-DEF-GHJ", fetchImpl });
  try {
    t.dispatchSubmit();
    fetchImpl.resolve({ status: 410 });
    await fetchImpl.promise;
    assert.equal(t.statusEl.textContent, JOIN_CODE_INVALID_MESSAGE);
    assert.equal(t.statusEl.hidden, false);
    assert.equal(t.inputEl.attrs["aria-invalid"], "true");
    assert.equal(t.buttonEl.disabled, false);
    assert.equal(t.calls.assigned.length, 0);
    assert.equal(t.calls.timerCleared, true);
  } finally {
    t.restore();
  }
});

test("join-code submit: live code hands off to the app with the normalized code", async () => {
  const fetchImpl = deferredFetch();
  const t = runDoorSubmit({ inputValue: "abc-def-ghj", fetchImpl });
  try {
    t.dispatchSubmit();
    // Loading state while the preview is in flight.
    assert.equal(t.buttonEl.disabled, true);
    assert.equal(t.buttonEl.textContent, "Checking…");
    assert.equal(t.inputEl.disabled, true);
    assert.equal(t.statusEl.textContent, "Checking your code…");
    fetchImpl.resolve({ status: 200 });
    await fetchImpl.promise;
    assert.deepEqual(t.calls.assigned, [`${ROOM_ORIGIN}/#code/ABC-DEF-GHJ`]);
    assert.equal(t.statusEl.textContent, "Code accepted — opening the app…");
    assert.equal(t.buttonEl.disabled, false);
    assert.equal(t.buttonEl.textContent, "Join with code");
    assert.equal(t.inputEl.disabled, false);
  } finally {
    t.restore();
  }
});

test("join-code submit: rate-limited and failed previews show distinct messages and retry", async () => {
  const cases = [
    [429, "Too many tries. Wait a moment and try again."],
    [500, "Something went wrong. Try again in a moment."]
  ];
  for (const [status, message] of cases) {
    const fetchImpl = deferredFetch();
    const t = runDoorSubmit({ inputValue: "ABC-DEF-GHJ", fetchImpl });
    try {
      t.dispatchSubmit();
      fetchImpl.resolve({ status });
      await fetchImpl.promise;
      assert.equal(t.statusEl.textContent, message, `status ${status}`);
      assert.equal(t.buttonEl.disabled, false, `status ${status}: form must be resubmittable`);
      // Retry after the error attempts the preview again — no stuck busy state.
      t.dispatchSubmit();
      assert.equal(fetchImpl.calls.length, 2, `status ${status}: retry must refetch`);
      await fetchImpl.promise; // drain the retry's completion while the stubs are live
    } finally {
      t.restore();
    }
  }
});

test("join-code submit: network failure and timeout show the offline message", async () => {
  const offline = "Couldn't reach the server. Check your connection and try again.";
  {
    const fetchImpl = deferredFetch();
    const t = runDoorSubmit({ inputValue: "ABC-DEF-GHJ", fetchImpl });
    try {
      t.dispatchSubmit();
      fetchImpl.reject(new Error("network down"));
      await fetchImpl.promise.then(() => {}, () => {});
      assert.equal(t.statusEl.textContent, offline);
      assert.equal(t.buttonEl.disabled, false);
    } finally {
      t.restore();
    }
  }
  {
    const fetchImpl = deferredFetch();
    const t = runDoorSubmit({ inputValue: "ABC-DEF-GHJ", fetchImpl });
    try {
      t.dispatchSubmit();
      t.fireTimer();
      assert.equal(t.statusEl.textContent, offline);
      assert.equal(t.buttonEl.disabled, false);
      // A late response after the timeout is dropped, not applied.
      fetchImpl.resolve({ status: 200 });
      await fetchImpl.promise;
      assert.equal(t.calls.assigned.length, 0);
    } finally {
      t.restore();
    }
  }
});

test("join-code submit: missing form origin and missing fetch degrade honestly", () => {
  {
    const t = runDoorSubmit({ inputValue: "ABC-DEF-GHJ", formOrigin: null });
    try {
      t.dispatchSubmit();
      assert.equal(t.statusEl.textContent, "Couldn't reach the room server from here. Use the Join link above instead.");
    } finally {
      t.restore();
    }
  }
  {
    const t = runDoorSubmit({ inputValue: "ABC-DEF-GHJ", fetchImpl: deferredFetch() });
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: undefined });
    try {
      t.dispatchSubmit();
      assert.equal(t.statusEl.textContent, "Couldn't reach the server. Check your connection and try again.");
    } finally {
      t.restore();
    }
  }
});

test("door #code/ deep link resolves through the same submit path", async () => {
  const fetchImpl = deferredFetch();
  const t = runDoorSubmit({ hash: "#code/abc-def-ghj", fetchImpl });
  try {
    // The deep link fills the form and submits it — one shared path.
    assert.equal(t.inputEl.value, "abc-def-ghj");
    assert.equal(fetchImpl.calls.length, 1);
    assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), { linkToken: "ABC-DEF-GHJ" });
    fetchImpl.resolve({ status: 200 });
    await fetchImpl.promise;
    assert.deepEqual(t.calls.assigned, [`${ROOM_ORIGIN}/#code/ABC-DEF-GHJ`]);
  } finally {
    t.restore();
  }
});

test("door #code/ deep link drops a stale completion after the hash moves on", async () => {
  const fetchImpl = deferredFetch();
  const t = runDoorSubmit({ hash: "#code/abc-def-ghj", fetchImpl });
  try {
    t.locationStub.hash = "#room/commons";
    fetchImpl.resolve({ status: 200 });
    await fetchImpl.promise;
    assert.equal(t.calls.assigned.length, 0, "stale deep-link completion must not navigate");
  } finally {
    t.restore();
  }
});

test("public door CSP permits only the same-origin preview fetch", () => {
  assert.match(PUBLIC_DOOR_CSP, /connect-src 'self';/);
  assert.doesNotMatch(PUBLIC_DOOR_CSP, /connect-src[^;]*(https?:|\*)/);
});
