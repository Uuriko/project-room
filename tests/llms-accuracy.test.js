// llms-accuracy.test.js — Crew D Lane 6 (2026-10-05).
//
// The agent discovery packet (llms.txt / llms-full.txt / kits.txt) makes
// concrete claims about the live server: tool counts and names per MCP
// profile, the four anonymous join readers, and one canonical MCP URL.
// This file pins those claims against the live HTTP boundary and the served
// agent card, so packet drift fails CI instead of reaching a cold agent.
// Companion to the agent-doc link check (johnstab-agent-doc-links); same
// spirit as tests/a2a-card-truth.test.js (card-versus-server contract).
//
// Authoring gate:
// 1. Contract: packet claims == live MCP catalogs + card endpoints.
// 2. Regression: a tool added/renamed in a profile, or a card URL revert,
//    makes the packet lie again (both happened on 2026-10-05: QA4 #1497
//    flipped the canonical MCP URL without updating the card; the Routes
//    core-set list drifted from the 19-tool paragraph).
// 3. tests/agent-discovery.test.js asserts packet text shape only; nothing
//    calls tools/list live or compares endpoints.mcp against the prose
//    canonical claim.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  llmsTxt, llmsFullTxt, kitsTxt, agentCard,
  ROOM_ORIGIN, ROOM_PUBLIC_WWW,
} from "../deploy/agent-discovery.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

// The four anonymous join readers, in packet order.
const JOIN_READERS = ["room_join_packet", "room_join_kits", "room_join_prompt", "room_mcp_snippet"];

// The 19 essential tools the packet names for the member core profile.
const CORE_19 = [
  "room_needs_me", "room_read_messages", "room_post_message", "room_reply",
  "room_list_requests", "room_read_request", "room_respond_to_request",
  "room_react", "dm_posted", "room_check_access", "room_create", "room_join",
  "room_put_file", "room_commit_file", "add_land_item", "list_land_queue",
  "wake_pause", "wake_resume", "bond_propose",
];

// Every snake_case tool the hosted-mcp bullet promises on the bearer URL.
const BULLET_TOOLS = [
  "bond_propose", "bond_accept", "bond_decline", "bond_revoke", "bond_list",
  "dm_posted", "room_list_peer_dms",
  "room_put_file", "room_list_files", "room_get_file", "room_discard_file", "room_commit_file",
  "wake_register", "wake_clear", "heartbeat_set", "heartbeat_get", "heartbeat_ack",
  "wake_pause", "wake_resume", "webhook_subscribe", "webhook_list", "webhook_unsubscribe",
  "inbox_put_attachment", "inbox_list_attachments", "inbox_get_attachment", "inbox_discard_attachment",
];

const PUBLIC_WORK_ANON = ["public_work_recommend", "public_work_read_task"];
const PUBLIC_WORK_ALL = [...PUBLIC_WORK_ANON,
  "public_work_claim", "public_work_renew", "public_work_release",
  "public_work_finish", "public_work_my_review"];

let origin, memberSecret, outsiderSecret;
let server, store, directory;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "llms-accuracy-"));
  store = new RoomStore(join(directory, "room.sqlite"));
  server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  const minted = await fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "LlmsAudit" }),
  });
  assert.equal(minted.status, 201, "identity mint must work for the fixture");
  const { secret } = await minted.json();
  memberSecret = secret;

  const room = await fetch(`${origin}/api/agent-rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ title: "LLMS accuracy fixture", purpose: "accuracy test" }),
  });
  assert.equal(room.status, 201, "room create must work for the fixture");

  // A second identity with no room membership: the outside-identity catalog.
  const outsider = await fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "LlmsOutsider" }),
  });
  assert.equal(outsider.status, 201, "second identity mint must work");
  outsiderSecret = (await outsider.json()).secret;
});

after(async () => {
  server.closeStreams();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

async function toolsList(params, secret) {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "acc", method: "tools/list", ...(params ? { params } : {}) }),
  });
  assert.equal(res.status, 200, "tools/list must answer 200");
  const body = await res.json();
  assert.ok(!body.error, `tools/list must not error: ${JSON.stringify(body.error)}`);
  return body.result.tools.map(t => t.name);
}

test("anonymous catalog is exactly the packet's six tools", async () => {
  const names = await toolsList();
  // Packet: "the four public join tools ... plus public_work_recommend and
  // public_work_read_task" / "six public tools with no credential".
  assert.deepEqual(names, [...JOIN_READERS, ...PUBLIC_WORK_ANON]);
  assert.ok(llmsTxt().includes("room_mcp_snippet"),
    "packet must name room_mcp_snippet among the four join tools");
});

test("outside identity gets the packet's seven public-work tools plus four join readers", async () => {
  const names = await toolsList(undefined, outsiderSecret);
  // Packet: "Outside identities get seven public-work tools plus four
  // documents by default."
  assert.deepEqual(names, [...JOIN_READERS, ...PUBLIC_WORK_ALL]);
});

test("member core profile is the packet's 19 essential tools plus the 4 join readers", async () => {
  const names = await toolsList(undefined, memberSecret);
  // Packet: "19 essential tools ... plus the 4 public join readers, so about 23 total".
  assert.equal(names.length, 23, `core profile must be 23 tools, got ${names.length}`);
  assert.deepEqual(names.slice(0, 19), CORE_19);
  assert.deepEqual(names.slice(19), JOIN_READERS);
});

test("full profile contains every tool the hosted-mcp bullet names", async () => {
  const names = await toolsList({ profile: "full" }, memberSecret);
  const missing = BULLET_TOOLS.filter(n => !names.includes(n));
  assert.deepEqual(missing, [], `bullet-named tools missing from full profile: ${missing.join(",")}`);
});

test("canonical MCP URL is one URL across packet, card, and skill", () => {
  const canonical = `${ROOM_ORIGIN}/mcp`;
  const card = agentCard();
  assert.equal(card.endpoints.mcp, canonical,
    "card endpoints.mcp must equal the prose canonical MCP URL");
  for (const [label, packet] of [["llms.txt", llmsTxt()], ["llms-full.txt", llmsFullTxt()], ["kits.txt", kitsTxt()]]) {
    assert.ok(!packet.includes(`paste ${ROOM_PUBLIC_WWW}/mcp`),
      `${label} must not instruct agents to paste the www alias as the MCP URL`);
  }
  assert.ok(llmsTxt().includes(`One canonical MCP URL: paste ${canonical}`),
    "packet must declare the canonical MCP URL");
  assert.ok(llmsTxt().includes(`${ROOM_PUBLIC_WWW}/mcp is an alias`),
    "packet keeps the www door as a documented alias");
});

test("Routes compact core set names the same tools as the 19-tool paragraph", () => {
  for (const [label, packet] of [["llms.txt", llmsTxt()], ["llms-full.txt", llmsFullTxt()]]) {
    const match = packet.match(/Their compact core set: ([^.]+)\./);
    assert.ok(match, `${label} must have a compact core set list`);
    const listed = match[1].split(/,\s*/).map(s => s.trim());
    const missing = CORE_19.filter(n => !listed.includes(n));
    assert.deepEqual(missing, [],
      `${label} compact core set is missing tools the 19-tool paragraph promises: ${missing.join(",")}`);
  }
});
