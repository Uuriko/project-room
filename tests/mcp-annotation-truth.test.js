// COMP-DEEP #4 — the MCP annotation truth gate.
//
// Before this gate, every tool factory stamped a template
// (idempotentHint:true, destructiveHint:false) on the tools it built: 64
// of 73 hosted write tools claimed an idempotency they did not have,
// routine lifecycle verbs (renew, record, begin) claimed destructive, and
// the tools that actually discard bytes (room_discard_file,
// squads_disband) claimed not to be destructive. Clients auto-approve and
// auto-retry from these hints, so a false hint is a behaviour bug, not a
// copy bug.
//
// The truth now lives in src/mcp-tool-annotations.mjs: one deliberate
// entry per tool (title, the four hints, and the idempotency `basis` —
// the handler evidence for the claim). This gate fails when:
//   1. any served or definable tool's title/annotations differ from the
//      registry (a factory re-stamping a template is exactly this);
//   2. a registry entry names a tool no catalog serves (stale truth);
//   3. an entry's idempotency basis disagrees with the tool's own input
//      schema (a command-id claim must REQUIRE its key — an optional key
//      means a keyless retry executes again, so the claim must be false);
//   4. the registry's read/write call disagrees with the independent
//      classifiers the dispatch code already uses (the API-key scope
//      funnel mcpRoomToolScope, the hosted-stdio write classifier
//      hostedStdioWriteTool, the AUX-08 contract table's read/write
//      access lines, and the public-work handler's act() dispatch);
//   5. a literal hint stamp (readOnlyHint:/destructiveHint:/
//      idempotentHint:) reappears in any definition site outside the
//      registry — there is no default left to inherit;
//   6. the registry is asked for a tool it does not know: it must throw,
//      so a new write tool without an explicit decision cannot be
//      defined at all (the refusal check, exercised below).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MCP_TOOL_ANNOTATIONS, annotateMcpTool, mcpToolAnnotation
} from "../src/mcp-tool-annotations.mjs";
import { listedMcpTools, livePublicMcpTools, liveEnrolledMcpTools } from "../server/mcp-discovery.mjs";
import { hostedMcpToolDefs, hostedRoomTools } from "../server/mcp-hosted-tools.mjs";
import { actionMetaToolDefs } from "../server/mcp-action-search.mjs";
import { MCP_JOIN_TOOLS } from "../server/mcp-http.mjs";
import { identityMintMcpDefinitions } from "../server/mcp-identity-mint.mjs";
import { publicWorkMcpDefinitions } from "../server/mcp-public-work.mjs";
import { roomTools, attentionTools } from "../client/mcp-stdio.mjs";
import { hostedStdioWriteTool, isHostedStdioTool } from "../server/mcp-full-profile.mjs";
import { mcpRoomToolScope } from "../server/mcp-room-profile.mjs";
import { MCP_TOOL_CONTRACTS } from "../server/mcp-tool-contracts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every catalog a client can be served, plus every definition array a
// listing is built from. The wake-ack tool is only constructed inside
// serveRoomMcp when a channel is configured; its name is recovered from
// the factory call sites in client/mcp-stdio.mjs (the factory itself
// throws at module load if the registry lacks an entry for it).
const stdioSource = readFileSync(join(root, "client/mcp-stdio.mjs"), "utf8");
const stdioFactoryNames = [...stdioSource.matchAll(/\btool\("([a-z0-9_]+)"/g)].map(match => match[1]);

const catalogs = {
  "profile public": livePublicMcpTools(),
  "profile core": listedMcpTools("core"),
  "profile lean": listedMcpTools("lean"),
  "profile full": listedMcpTools("full"),
  "profile enrolled": liveEnrolledMcpTools(),
  "hosted defs": hostedMcpToolDefs,
  "meta defs": [...actionMetaToolDefs],
  "join defs": [...MCP_JOIN_TOOLS],
  "mint defs": [...identityMintMcpDefinitions],
  "public work defs": [...publicWorkMcpDefinitions],
  "stdio tools": roomTools,
  "stdio attention tools": attentionTools
};

const byName = new Map();
for (const tools of Object.values(catalogs)) {
  for (const tool of tools) {
    if (!byName.has(tool.name)) byName.set(tool.name, tool);
  }
}

// The comparison the gate runs on every served tool. Returning the list
// of problems (instead of asserting inline) lets the self-test below
// prove the gate actually bites on a deliberately wrong annotation.
function annotationProblems(tool) {
  const problems = [];
  let entry;
  try {
    entry = mcpToolAnnotation(tool?.name);
  } catch {
    return [`${tool?.name}: no registry entry (annotateMcpTool must refuse it)`];
  }
  if (typeof tool.title !== "string" || tool.title.length === 0) {
    problems.push(`${tool.name}: missing title`);
  } else if (tool.title !== entry.title) {
    problems.push(`${tool.name}: title "${tool.title}" != registry "${entry.title}"`);
  }
  for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    if (tool.annotations?.[hint] !== entry.annotations[hint]) {
      problems.push(`${tool.name}: ${hint} is ${tool.annotations?.[hint]}, registry says ${entry.annotations[hint]}`);
    }
  }
  return problems;
}

test("every served and definable tool carries exactly its registry title + annotations", () => {
  const problems = [];
  for (const [catalog, tools] of Object.entries(catalogs)) {
    for (const tool of tools) {
      for (const problem of annotationProblems(tool)) problems.push(`${catalog}: ${problem}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the gate bites: a deliberately wrong annotation is reported, the true one is not", () => {
  const truthful = byName.get("room_post_message");
  assert.deepEqual(annotationProblems(truthful), []);
  // room_post_message is the canonical old lie: its command id is
  // optional and server-minted when omitted, so a keyless retry posts
  // twice. Stamp the old template claim back on and the gate must fail.
  const lying = {
    ...truthful,
    annotations: { ...truthful.annotations, idempotentHint: true }
  };
  const problems = annotationProblems(lying);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /room_post_message: idempotentHint is true, registry says false/);
  const untitled = { ...truthful, title: undefined };
  assert.match(annotationProblems(untitled)[0], /room_post_message: missing title/);
});

test("registry has no stale entries: every entry is served or factory-built", () => {
  const served = new Set([...byName.keys(), ...stdioFactoryNames]);
  const stale = Object.keys(MCP_TOOL_ANNOTATIONS).filter(name => !served.has(name));
  assert.deepEqual(stale, []);
});

test("refusal: a tool with no registry entry cannot be annotated or defined", () => {
  assert.throws(
    () => annotateMcpTool({ name: "room_brand_new_write", description: "x", inputSchema: {} }),
    /no annotation entry/);
  assert.throws(() => mcpToolAnnotation("room_brand_new_write"), /no annotation entry/);
});

test("idempotency bases agree with the claims and with the input schemas", () => {
  const problems = [];
  for (const [name, entry] of Object.entries(MCP_TOOL_ANNOTATIONS)) {
    const { readOnlyHint, idempotentHint } = entry.annotations;
    const tool = byName.get(name);
    const required = new Set(tool?.inputSchema?.required ?? []);
    const properties = tool?.inputSchema?.properties ?? {};
    if (entry.basis === "read") {
      if (!readOnlyHint || !idempotentHint || entry.annotations.destructiveHint) {
        problems.push(`${name}: basis "read" must be a non-destructive idempotent read`);
      }
      continue;
    }
    if (readOnlyHint) problems.push(`${name}: basis "${entry.basis}" on a readOnly tool`);
    // The claim and the evidence class must agree in both directions.
    if (idempotentHint && (entry.basis === "none" || entry.basis === "optional-key")) {
      problems.push(`${name}: claims idempotentHint:true on basis "${entry.basis}"`);
    }
    if (!idempotentHint && entry.basis !== "none" && entry.basis !== "optional-key") {
      problems.push(`${name}: basis "${entry.basis}" is dedup evidence but the claim is false`);
    }
    // Schema cross-checks: the dedup key a basis rests on must be a
    // REQUIRED input — an optional key cannot make a call idempotent.
    // (room_acknowledge_wake is built only inside serveRoomMcp when a
    // channel is configured, so it has no catalog entry here; the stale
    // entry test above covers it via the factory call-site scan.)
    if (!tool) continue;
    if (entry.basis === "request-journal" && !required.has("requestId")) {
      problems.push(`${name}: basis "request-journal" but requestId is not required`);
    }
    if (entry.basis === "command-id" && !required.has("requestId") && !required.has("id")) {
      // The dedup key is the caller's stable command id: `requestId` on
      // the work/help/reply families, `id` on the bond/DM commands.
      problems.push(`${name}: basis "command-id" but neither requestId nor id is required`);
    }
    if (entry.basis === "single-use-id" && !required.has("id")) {
      problems.push(`${name}: basis "single-use-id" but id is not required`);
    }
    if (entry.basis === "terminal-id"
      && ![...required].some(key => ["id", "subscriptionId", "inviteId", "claimId"].includes(key))) {
      problems.push(`${name}: basis "terminal-id" but no target id is required`);
    }
    if (entry.basis === "revision-fence" && !required.has("expectedRevision")) {
      problems.push(`${name}: basis "revision-fence" but expectedRevision is not required`);
    }
    if (entry.basis === "ack" && !required.has("signalIds")) {
      problems.push(`${name}: basis "ack" but signalIds is not required`);
    }
    if (entry.basis === "documented-noop" && !(required.has("claimId") && required.has("pullRequest"))) {
      problems.push(`${name}: basis "documented-noop" but claimId/pullRequest are not required`);
    }
    if (entry.basis === "deterministic-key" && !("roomId" in properties && "requestId" in properties)) {
      problems.push(`${name}: basis "deterministic-key" but roomId/requestId are not inputs`);
    }
  }
  assert.deepEqual(problems, []);
});

test("read/write calls agree with the dispatch classifiers, not just the registry", () => {
  const problems = [];
  const expectWrite = (name, write, source) => {
    const entry = MCP_TOOL_ANNOTATIONS[name];
    if (!entry) return;
    if (entry.annotations.readOnlyHint === write) {
      problems.push(`${name}: registry says ${write ? "write" : "read"} but ${source} says ${write ? "read" : "write"}`);
    }
  };
  // The API-key scope funnel for the hosted native room tools.
  for (const tool of hostedRoomTools) {
    expectWrite(tool.name, mcpRoomToolScope(tool.name) === "rooms:write", "mcpRoomToolScope");
  }
  // The hosted full-profile funnel's own write classifier (family-derived).
  for (const name of Object.keys(MCP_TOOL_ANNOTATIONS)) {
    if (isHostedStdioTool(name)) expectWrite(name, hostedStdioWriteTool(name), "hostedStdioWriteTool");
  }
  // The AUX-08 contract table states read/write in each tool's access line.
  for (const [name, contract] of Object.entries(MCP_TOOL_CONTRACTS)) {
    if (contract.access.startsWith("read,")) expectWrite(name, false, "MCP_TOOL_CONTRACTS");
    else if (contract.access.startsWith("write,")) expectWrite(name, true, "MCP_TOOL_CONTRACTS");
  }
  // The public-work handler routes everything except recommend/read_task/
  // my_review through publicWorkClaims.act() — those three are the writes'
  // complement, derived from server/mcp-public-work.mjs's dispatch.
  for (const tool of publicWorkMcpDefinitions) {
    expectWrite(tool.name, ["public_work_claim", "public_work_renew", "public_work_release", "public_work_finish"].includes(tool.name),
      "public-work act() dispatch");
  }
  assert.deepEqual(problems, []);
});

test("no literal hint stamp survives outside the registry", () => {
  const offenders = [];
  for (const dir of ["client", "server", "src"]) {
    for (const file of readdirSync(join(root, dir))) {
      if (!/\.(mjs|js)$/.test(file) || file === "mcp-tool-annotations.mjs") continue;
      const text = readFileSync(join(root, dir, file), "utf8");
      if (/(readOnlyHint|destructiveHint|idempotentHint)\s*:/.test(text)) offenders.push(`${dir}/${file}`);
    }
  }
  assert.deepEqual(offenders, [],
    "annotations may only be stamped in src/mcp-tool-annotations.mjs");
});

test("false-claim census: no write claims idempotency without a dedup basis", () => {
  const writes = Object.entries(MCP_TOOL_ANNOTATIONS)
    .filter(([, entry]) => !entry.annotations.readOnlyHint);
  const claiming = writes.filter(([, entry]) => entry.annotations.idempotentHint);
  for (const [name, entry] of claiming) {
    assert.notEqual(entry.basis, "none", `${name} claims idempotent with no basis`);
    assert.notEqual(entry.basis, "optional-key", `${name} claims idempotent on an optional key`);
  }
  // The two directions of the old error, pinned by name so a regression
  // names the tool it lied about.
  for (const name of ["room_discard_file", "inbox_discard_attachment", "squads_disband",
    "webhook_unsubscribe", "room_revoke_agent_invite", "bond_revoke", "room_close_work_claim"]) {
    assert.equal(MCP_TOOL_ANNOTATIONS[name].annotations.destructiveHint, true, `${name} discards/retires and must say so`);
  }
  for (const name of ["room_renew_claim", "room_begin_work", "room_record_completion",
    "room_release_claim", "room_offer_help", "room_reply", "public_work_release"]) {
    assert.equal(MCP_TOOL_ANNOTATIONS[name].annotations.destructiveHint, false, `${name} is a routine lifecycle verb, not destructive`);
  }
  for (const name of ["room_post_message", "add_land_item", "remove_land_item", "report_tip",
    "room_create_agent_invite", "webhook_subscribe", "room_join", "room_introduce_outside_agent"]) {
    assert.equal(MCP_TOOL_ANNOTATIONS[name].annotations.idempotentHint, false, `${name} has no required dedup key and must not claim idempotent`);
  }
});
