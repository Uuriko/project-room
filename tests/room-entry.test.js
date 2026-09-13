import test from "node:test";
import assert from "node:assert/strict";
import { roomEntry, publicRoomDoorHtml, isPublicRoomDoorPath, wantsPublicDoorHtml, PUBLIC_DOOR_PATHS } from "../deploy/room-entry.mjs";
import { ROOM_ORIGIN, COMPUTE_DOOR } from "../deploy/agent-discovery.mjs";

const FORBIDDEN = /Bearer |ROOM_AGENT_TOKEN|sk-|password|@gmail|John |Potter |Uuriko@|acct-|memberId":"[^c]/i;

test("unlisted entry opens the isolated Room without forwarding input or embedding credentials", async () => {
  const response = roomEntry(new Request("https://www.trydemigod.com/room?return=untrusted"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  const html = await response.text();
  assert.match(html, /href="https:\/\/project-room-staging.getdasha.workers.dev"/);
  assert.match(html, /--ink:#0B120F/);
  assert.match(html, /href="\/contact"/);
  assert.match(html, /Paste your room key/);
  assert.match(html, /Membership and guest kit discovery stay free\. Charge isn’t for joining as an agent\./);
  assert.match(html, /Connect an agent/);
  assert.match(html, /Agents: Use my AI → paste the packet\. No Room key in chat\./);
  assert.match(html, /Agent handles stay loud\. Done lands as a receipt\./);
  assert.match(html, /<strong><a href="\/room\/llms.txt">Packet<\/a><\/strong>/);
  assert.match(html, /<strong><a href="\/room\/llms.txt">Guest<\/a><\/strong>/);
  assert.match(html, /<strong><a href="\/room\/llms.txt">Add agent<\/a><\/strong>/);
  assert.match(html, /Owner mints ga1\. guest-agent \(not human #join\/\)\./);
  assert.match(html, /Owner Add agent · enrolled digest key\./);
  assert.match(html, /Built-ins → Custom API connector \(Member\+kit\) → Receipt on connect\./);
  assert.match(html, /Connect tools as agents — research, edit, plan — not one mega chat\./);
  assert.match(html, /plan: frontier member · do: workhorse member · Steer mid-task = Handoff note, not cancel\./);
  assert.match(html, /Works with/);
  assert.match(html, /href="\/room\/llms.txt">Claude Code</);
  assert.match(html, /href="\/room\/kits">Kits</);
  assert.match(html, /href="\/room\/llms.txt"/);
  assert.match(html, /href="\/room\/\.well-known\/agent\.json"/);
  assert.doesNotMatch(html, /marketplace/i);
  assert.doesNotMatch(html, /muse\.ai/i);
  assert.doesNotMatch(html, /\bAmp\b/);
  assert.doesNotMatch(html, /\$|pricing|per month|credit/i);
  assert.match(html, /github.com\/Uuriko\/project-room/);
  assert.ok(!html.includes("untrusted"));
  assert.ok(!html.includes("<script"));
  assert.doesNotMatch(html, /dasha\.fun|iframe|walletconnect|Bearer |ROOM_AGENT_TOKEN/i);
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
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/llms-full.txt")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/skill.md")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/AGENTS.md")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/skill")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/agent.json")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/kits")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/apps")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/tools")), null);
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
  assert.match(html, /Work Items, next actions, receipts\. Agents are Members\./);
  assert.match(html, new RegExp(`href="${origin}"`));
  assert.match(html, />Open</);
  assert.match(html, new RegExp(`href="${origin}/#join/"`));
  assert.match(html, />Join</);
  assert.match(html, /Membership and guest kit discovery stay free\. Charge isn’t for joining as an agent\./);
  assert.match(html, /href="#connect"/);
  assert.match(html, /Connect an agent/);
  assert.match(html, /id="connect"/);
  assert.match(html, /Agents: Use my AI → paste the packet\. No Room key in chat\./);
  assert.match(html, /Agent handles stay loud\. Done lands as a receipt\./);
  assert.match(html, /href="\/room\/llms.txt">Packet</);
  assert.match(html, /href="\/room\/llms.txt">Guest</);
  assert.match(html, /Owner mints ga1\. guest-agent \(not human #join\/\)\./);
  assert.match(html, /href="\/room\/llms.txt">Add agent</);
  assert.match(html, /Owner Add agent · enrolled digest key\./);
  assert.match(html, /href="\/room\/kits">Kits</);
  assert.match(html, /Built-ins → Custom API connector \(Member\+kit\) → Receipt on connect\./);
  assert.match(html, /Connect tools as agents — research, edit, plan — not one mega chat\./);
  assert.match(html, /plan: frontier member · do: workhorse member · Steer mid-task = Handoff note, not cancel\./);
  assert.doesNotMatch(html, /marketplace/i);
  assert.doesNotMatch(html, /muse\.ai/i);
  assert.doesNotMatch(html, /\bAmp\b/);
  assert.doesNotMatch(html, /\$|pricing|per month/i);
  assert.match(html, /Works with/);
  assert.match(html, /href="\/room\/llms.txt">Claude Code</);
  assert.match(html, /href="\/room\/llms.txt">Codex</);
  assert.match(html, /href="\/room\/llms.txt">OpenCode</);
  assert.match(html, /href="\/room\/llms.txt">Cursor</);
  assert.match(html, new RegExp(COMPUTE_DOOR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /Compute stays separate/);
  assert.match(html, /--ink:#070608/);
  assert.match(html, /--acid:#dfff00/);
  assert.ok(!html.includes("<script"));
  assert.equal(FORBIDDEN.test(html), false);
  assert.doesNotMatch(html, /dasha\.fun|iframe|walletconnect|Bearer |ROOM_AGENT_TOKEN|# Project Room|getone\.one|Amore/i);
});
