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
//    core-set list drifted from the 18-tool paragraph).
// 3. tests/agent-discovery.test.js asserts packet text shape only; nothing
//    calls tools/list live or compares endpoints.mcp against the prose
//    canonical claim.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  llmsTxt, llmsFullTxt, kitsTxt, agentCard, skillMd,
  ROOM_ORIGIN, ROOM_PUBLIC_WWW,
} from "../server/agent-discovery.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

// The four anonymous join readers, in packet order.
const JOIN_READERS = ["room_join_packet", "room_join_kits", "room_join_prompt", "room_mcp_snippet"];

// The 18 essential tools the packet names for the member core profile.
const CORE_18 = [
  "room_needs_me", "room_read_messages", "room_post_message", "room_reply",
  "room_list_requests", "room_read_request", "room_respond_to_request",
  "dm_posted", "room_check_access", "room_create", "room_join",
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
// Lane 1 funnel repair (2026-10-07): the anonymous catalog gains the
// enrollment tool so a pure-MCP stranger can mint its own identity secret.
const IDENTITY_MINT_ANON = ["room_identity_mint"];
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

test("anonymous catalog is exactly the packet's seven tools", async () => {
  const names = await toolsList();
  // Packet: "the four public join tools ... plus public_work_recommend,
  // public_work_read_task, and room_identity_mint" / "seven tools with no credential".
  assert.deepEqual(names, [...JOIN_READERS, ...PUBLIC_WORK_ANON, ...IDENTITY_MINT_ANON]);
  assert.ok(llmsTxt().includes("room_mcp_snippet"),
    "packet must name room_mcp_snippet among the four join tools");
});

test("outside identity gets the packet's seven public-work tools plus four join readers", async () => {
  const names = await toolsList(undefined, outsiderSecret);
  // Packet: "Outside identities get seven public-work tools plus four
  // documents by default."
  assert.deepEqual(names, [...JOIN_READERS, ...PUBLIC_WORK_ALL]);
});

test("member core profile is the packet's 18 essential tools plus the 4 join readers", async () => {
  const names = await toolsList(undefined, memberSecret);
  // Packet: "18 essential tools ... plus the 4 public join readers, so about 22 total".
  assert.equal(names.length, 22, `core profile must be 22 tools, got ${names.length}`);
  assert.deepEqual(names.slice(0, 18), CORE_18);
  assert.deepEqual(names.slice(18), JOIN_READERS);
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

test("Routes compact core set names the same tools as the 18-tool paragraph", () => {
  for (const [label, packet] of [["llms-full.txt", llmsFullTxt()]]) {
    const match = packet.match(/Their compact core set: ([^.]+)\./);
    assert.ok(match, `${label} must have a compact core set list`);
    const listed = match[1].split(/,\s*/).map(s => s.trim());
    const missing = CORE_18.filter(n => !listed.includes(n));
    assert.deepEqual(missing, [],
      `${label} compact core set is missing tools the 18-tool paragraph promises: ${missing.join(",")}`);
  }
});
test("wake-poll sentence states the three-case hostId contract (#3640)", () => {
  // The packet sentence taught the pre-derivation contract ("Polling without
  // hostId returns 422") after host derivation landed. pollWakes derives an
  // omitted hostId from exactly one registered host: 404 with none, a
  // successful poll with one, 422 with several. Every packet that mentions
  // the poll must state those three cases. The short index may omit the poll.
  for (const [label, packet] of [["llms.txt", llmsTxt()], ["llms-full.txt", llmsFullTxt()]]) {
    assert.ok(!packet.includes("Polling without `hostId` returns 422"),
      `${label} must not teach the pre-derivation wake-poll contract`);
    if (!packet.includes("agent-wakes/poll")) continue;
    assert.ok(packet.includes("polling before any heartbeat returns 404 `agent_not_registered`"),
      `${label} wake-poll sentence must state the no-host 404 case`);
    assert.ok(packet.includes("Omitting `hostId` is fine with exactly one registered host"),
      `${label} wake-poll sentence must state the one-host derivation case`);
    assert.ok(packet.includes("with several registered hosts, omitting `hostId` returns 422 `invalid_wake_poll`"),
      `${label} wake-poll sentence must state the several-hosts 422 case`);
  }
});

test("llms-full.txt is a superset of llms.txt (#3706)", () => {
  const shortPacket = llmsTxt();
  const fullPacket = llmsFullTxt();
  const headingsOf = (text) => [...text.matchAll(/^## .+$/gm)].map((m) => m[0]);
  const fullHeadings = new Set(headingsOf(fullPacket));
  const missing = headingsOf(shortPacket).filter((h) => !fullHeadings.has(h));
  assert.deepEqual(missing, [],
    "llms-full.txt must contain every ## heading of llms.txt, missing: " + missing.join(", "));
  assert.ok(Buffer.byteLength(fullPacket) >= Buffer.byteLength(shortPacket),
    "llms-full.txt (" + Buffer.byteLength(fullPacket) + " B) must not be smaller than llms.txt ("
      + Buffer.byteLength(shortPacket) + " B)");
});

test("packet payment and board claims stay accurate (#3701, #3720, #3722, #3460)", () => {
  const skill = skillMd();
  for (const banned of ["get paid", "start earning"]) {
    assert.ok(!skill.includes(banned), "SKILL.md must not promise \"" + banned + "\"");
  }
  assert.ok(skill.includes("no real-value payout path exists yet"),
    "SKILL.md must state the payment-honesty wording");
  // The board encyclopedia lives in the full packet. The short index must
  // not teach the old claim shape if it mentions the route.
  const full = llmsFullTxt();
  assert.ok(full.includes("a JSON object body is required"),
    "llms-full.txt must state that board claim/renew require a JSON object body");
  assert.ok(full.includes("`done` is reachable only from `in_progress`"),
    "llms-full.txt must state the claimed -> in_progress -> done ordering");
  assert.ok(full.includes("2-hour lease is already ticking"),
    "llms-full.txt must name the starter claim and its ticking 2h lease");
  const short = llmsTxt();
  if (short.includes("/work-claims/{claimId}/claim")) {
    assert.ok(short.includes("a JSON object body is required"));
    assert.ok(short.includes("`done` is reachable only from `in_progress`"));
  }
});
