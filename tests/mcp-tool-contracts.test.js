// AUX-08 lint: on the full MCP profile, each front-door tool (core and lean
// lists) says its access, its cost and its REST twin in the served
// description. The REST twin must agree with the parity table in
// tests/mcp-core-rest-parity.test.js. Core and lean keep short blurbs; their
// byte budget is pinned in tests/mcp-core-profile.test.js.
// KNOWN_UNCOVERED is a ratchet: a new tool on ANY served profile must
// ship with a contract, and a tool that gains one must leave this list
// (AUX-08b). The ratchet used to enumerate only the full profile, which
// made public-profile-only tools structurally invisible to it —
// room_identity_mint (anonymous identity minting, served only by
// livePublicMcpTools) escaped both this table and the ratchet that way.
import test from "node:test";
import assert from "node:assert/strict";
import { listedMcpTools, liveEnrolledMcpTools, livePublicMcpTools } from "../server/mcp-discovery.mjs";
import { MCP_TOOL_CONTRACTS, mcpToolContractLine, withMcpToolContract } from "../server/mcp-tool-contracts.mjs";
import { CORE_REST_TWINS, CORE_REST_EXEMPT } from "./mcp-core-rest-parity.test.js";
import { GUEST_WRITABLE_TOOLS, T1_WRITABLE_TOOLS } from "../server/capability-visibility.mjs";
import { buildWorkCommand } from "../client/work-actions.mjs";
import { planBegin } from "../client/begin-work.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event } from "../src/events.js";

export const KNOWN_UNCOVERED = Object.freeze(new Set([
  "bounty_accept", "bounty_claim", "bounty_dispute",
  "bounty_finalize", "bounty_fund", "bounty_list", "bounty_post", "bounty_read_balances", "bounty_read_history",
  "bounty_submit", "bounty_transfer", "bounty_watch", "public_work_claim",
  "public_work_finish", "public_work_my_review", "public_work_read_task", "public_work_recommend",
  "public_work_release", "public_work_renew",
 "room_activation_pack", "room_assistant_action", "room_assistant_context",
  "room_create_agent_invite", "room_decide_access_request", "room_discard_file",
  "room_get_file", "room_introduce_outside_agent", "room_list_access_requests",
  "room_list_agent_invites", "room_list_events", "room_list_outside_agents",
  "room_list_peer_dms", "room_member_card", "room_post_draft",
 "room_read_board", "room_read_inbox", "room_read_result",
  "room_read_work_discussion",
 "room_release_help_offer",
 "room_revoke_agent_invite",
  "room_set_member_claim_cap",
  "room_withdraw_help_offer", "room_work_claim_provenance", 
  
  ]));

const CONTRACT_RE = /Access: (read|write|same as)[^.]*\. Cost: [^.]+\. REST: .+\.$/s;

test("text-result REST contract names the actual completion command, not a new post", () => {
  const command = buildWorkCommand("room_submit_text_result", {
    requestId: "contract-result", workItemId: "work", expectedRevision: 2,
    summary: "done", nextAction: "none", evidenceMessageId: "message", evidenceMessageEventId: "event",
    evidenceVersion: "sha256:" + "0".repeat(64), previousCompletionEventId: null, producerId: null
  });
  assert.ok(MCP_TOOL_CONTRACTS.room_submit_text_result.rest.includes(`(${command.type})`));
});

test("begin-work REST contract covers every actual planner stage", () => {
  const member = { id: "member", active: true, permissions: ["accept_work", "write_external"] };
  const scope = { repository: "repo", ref: "main", paths: ["src/file"], expiresAt: "2099-01-01T00:00:00.000Z" };
  for (const [state, mode] of [["proposed", "write"], ["accepted", "write"], ["accepted", "read"]]) {
    const item = { id: "work", accountableMemberId: member.id, revision: 0, state, mode };
    const { stage } = planBegin(item, member, { scope });
    assert.ok(stage);
    const command = buildWorkCommand(stage.action, stage.args);
    assert.ok(MCP_TOOL_CONTRACTS.room_begin_work.rest.includes(command.type), command.type);
  }
});

test("clear-halt description does not invent a self-clear restriction", t => {
  const store = new RoomStore(":memory:"); t.after(() => store.close());
  const make = (id, type, data) => event({ id, actorId: "owner", roomId: "commons", type, data });
  store.initialize([...initialRoom("commons"),
    make("propose", "work.proposed", { workItemId: "work", title: "Task", definitionOfDone: "Done", accountableMemberId: "owner", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false }),
    make("accept", "work.accepted", { workItemId: "work", expectedRevision: 0 }),
    make("halt", "work.handoff_recorded", { workItemId: "work", expectedRevision: 1, doneSummary: "Partial", nextAction: "Continue", limitReason: "Stop", haltAll: true })
  ]);
  const key = store.issueAccessKey("commons", "owner");
  const receipt = store.command(key, "commons", { id: "clear-self", type: "work.halt_cleared", data: { memberId: "owner", haltEventId: "halt" } });
  assert.equal(receipt.event.type, "work.halt_cleared");
  const served = listedMcpTools("full").find(tool => tool.name === "room_clear_halt");
  assert.doesNotMatch(served.description, /cannot clear (?:its|their) own halt/);
});

test("full: every contracted tool states access, cost and REST twin", () => {
  const tools = listedMcpTools("full").filter(tool => MCP_TOOL_CONTRACTS[tool.name]);
  assert.ok(tools.length >= 20, "front door is real");
  const bad = tools.filter(tool => !CONTRACT_RE.test(tool.description) || !tool.description.endsWith(mcpToolContractLine(tool.name)));
  assert.deepEqual(bad.map(tool => tool.name), []);
});

test("full: every front-door tool on core and lean has a contract", () => {
  const front = new Set([...listedMcpTools("core"), ...listedMcpTools("lean")].map(tool => tool.name));
  assert.deepEqual([...front].filter(name => !MCP_TOOL_CONTRACTS[name]), []);
});

// Every verb the server serves, on any profile. The public profile is
// the one the full-only ratchet could not see: it carries the join
// tools, the anonymous public-work tools and room_identity_mint.
const allServedNames = () => [...new Set([
  ...listedMcpTools("full"),
  ...listedMcpTools("core"),
  ...listedMcpTools("lean"),
  ...livePublicMcpTools(),
  ...liveEnrolledMcpTools()
].map(tool => tool.name))];

test("ratchet: no new tool on any served profile without a contract, no stale exemption", () => {
  const names = allServedNames();
  const missing = names.filter(name => !MCP_TOOL_CONTRACTS[name] && !KNOWN_UNCOVERED.has(name));
  assert.deepEqual(missing, [], "new tools need an entry in server/mcp-tool-contracts.mjs");
  const stale = [...KNOWN_UNCOVERED].filter(name => MCP_TOOL_CONTRACTS[name] || !names.includes(name));
  assert.deepEqual(stale, [], "drop these from KNOWN_UNCOVERED");
});

test("public: room_identity_mint carries a contract naming its HTTP mint twin", () => {
  const pub = livePublicMcpTools().map(tool => tool.name);
  assert.ok(pub.includes("room_identity_mint"), "mint is served on the public profile");
  assert.ok(!listedMcpTools("full").map(tool => tool.name).includes("room_identity_mint"),
    "mint is not on the full profile — the reason the full-only ratchet missed it");
  const contract = MCP_TOOL_CONTRACTS.room_identity_mint;
  assert.ok(contract, "room_identity_mint needs an entry in server/mcp-tool-contracts.mjs");
  assert.ok(contract.access.startsWith("write"), "mint is a write (readOnlyHint=false)");
  assert.equal(contract.rest, "POST /api/agent-identities");
});

test("core and lean stay short: no contract line", () => {
  for (const tool of [...listedMcpTools("core"), ...listedMcpTools("lean")]) {
    assert.ok(!tool.description.includes("Access: "), `${tool.name} carries the contract line on a short profile`);
  }
});

test("access word matches readOnlyHint", () => {
  for (const tool of listedMcpTools("full").filter(tool => MCP_TOOL_CONTRACTS[tool.name])) {
    const access = MCP_TOOL_CONTRACTS[tool.name].access;
    const read = tool.annotations?.readOnlyHint !== false;
    assert.equal(access.startsWith("read"), read, `${tool.name}: access "${access}" vs readOnlyHint ${tool.annotations?.readOnlyHint}`);
  }
});

test("REST twin agrees with the parity table", () => {
  for (const [name, twin] of Object.entries(CORE_REST_TWINS)) {
    const rest = MCP_TOOL_CONTRACTS[name]?.rest;
    assert.ok(rest, `${name} has no contract`);
    for (const entry of twin) {
      const needle = typeof entry === "string" ? entry : `(${entry.event})`;
      assert.ok(rest.includes(needle), `${name}: contract REST "${rest}" does not name ${needle}`);
    }
  }
  for (const name of Object.keys(CORE_REST_EXEMPT)) {
    assert.ok(/^(none|the wrapped action)/.test(MCP_TOOL_CONTRACTS[name]?.rest ?? ""), `${name} is exempt and must not claim a twin`);
  }
});

test("no stale contracts and the line is added once", () => {
  const served = new Set(allServedNames());
  for (const name of Object.keys(MCP_TOOL_CONTRACTS)) assert.ok(served.has(name), `${name} is not served; drop its contract`);
  const once = withMcpToolContract("room_post_message", withMcpToolContract("room_post_message", "Post."));
  assert.equal(once.split("Access:").length, 2);
  assert.equal(withMcpToolContract("not_a_tool", "x"), "x");
});


// The access words must match the catalog predicate in
// server/capability-visibility.mjs: a write tool outside GUEST_WRITABLE_TOOLS is
// hidden from guest-only agents, and one outside T1_WRITABLE_TOOLS from
// read-only-tier agents, so its contract has to say so.
test("contract access words agree with the guest and read-only-tier write sets", () => {
  const writes = new Map(listedMcpTools("full").map(tool => [tool.name, tool.annotations?.readOnlyHint === false]));
  const wrong = [];
  for (const [name, contract] of Object.entries(MCP_TOOL_CONTRACTS)) {
    if (!writes.get(name) || contract.access.startsWith("same as")) continue;
    if (!GUEST_WRITABLE_TOOLS.has(name) && !/hidden from guest/.test(contract.access)) wrong.push(`${name}: guests`);
    if (GUEST_WRITABLE_TOOLS.has(name) && !/guests allowed/.test(contract.access)) wrong.push(`${name}: guests allowed`);
    if (!T1_WRITABLE_TOOLS.has(name) && !/read-only-tier/.test(contract.access)) wrong.push(`${name}: read-only tier`);
  }
  assert.deepEqual(wrong, []);
});
