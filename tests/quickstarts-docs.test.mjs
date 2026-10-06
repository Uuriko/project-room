// O012/O013: quickstart docs must cite only real product surface.
// Contract: every button, command, endpoint, and tool named in the two
// quickstarts exists in the checked-in product. This catches docs drift
// when the UI copy, the join command, or the hosted-MCP snippet changes.
// Distinct from docs-relative-links (link resolution) and
// entry-docs-start-here (AGENT-START-HERE shape): those never assert that
// a cited UI element actually exists.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const html = () => read("index.html");
const inboxDoc = () => read("docs/INBOX-QUICKSTART.md");
const connectDoc = () => read("docs/CONNECT-AGENT-QUICKSTART.md");

const orderedSteps = (doc) =>
  [...doc.matchAll(/^(\d+)\.\s/gm)].map((m) => Number(m[1]));

const assertOrdered = (doc, file) => {
  const steps = orderedSteps(doc);
  assert.ok(steps.length >= 4, `${file}: expected >=4 ordered steps, got ${steps.length}`);
  assert.deepEqual(
    steps,
    steps.map((_, i) => i + 1),
    `${file}: steps must start at 1 and increment by 1`,
  );
};

test("inbox quickstart exists with ordered numbered steps", () => {
  assert.ok(existsSync(join(ROOT, "docs/INBOX-QUICKSTART.md")), "docs/INBOX-QUICKSTART.md is missing");
  assertOrdered(inboxDoc(), "docs/INBOX-QUICKSTART.md");
});

test("inbox quickstart cites only real UI surface", () => {
  const doc = inboxDoc();
  const page = html();
  for (const ui of ["Continue with Google", "Connect Gmail", "Personalize setup"]) {
    assert.ok(doc.includes(ui), `doc cites "${ui}" but never names it`);
    assert.ok(page.includes(ui), `"${ui}" is cited in the doc but not found in index.html`);
  }
  assert.ok(page.includes('id="nav-inbox"'), "Inbox nav button is missing from index.html");
  assert.ok(doc.includes("Inbox"), "doc never names the Inbox nav button");
  assert.ok(
    page.includes("imports up to 25 recent inbox messages"),
    "the 25-message import-limit copy is missing from index.html",
  );
  assert.ok(doc.includes("25"), "doc never states the 25-message import limit");
  assert.ok(
    page.includes("stays private until you choose to share it"),
    "the inbox privacy copy is missing from index.html",
  );
});

test("inbox quickstart links to depth instead of duplicating it", () => {
  const doc = inboxDoc();
  assert.ok(doc.includes("HUMAN-ONBOARDING.md"), "no depth link to the full human guide");
  assert.ok(existsSync(join(ROOT, "docs/HUMAN-ONBOARDING.md")), "HUMAN-ONBOARDING.md is missing");
});

test("agent-connect quickstart exists with ordered steps and complements AGENT-START-HERE", () => {
  assert.ok(
    existsSync(join(ROOT, "docs/CONNECT-AGENT-QUICKSTART.md")),
    "docs/CONNECT-AGENT-QUICKSTART.md is missing",
  );
  const doc = connectDoc();
  assertOrdered(doc, "docs/CONNECT-AGENT-QUICKSTART.md");
  assert.ok(
    doc.includes("AGENT-START-HERE.md"),
    "must point at AGENT-START-HERE.md instead of duplicating the public-task path",
  );
  assert.ok(
    !doc.toLowerCase().includes("public-work/match"),
    "duplicates AGENT-START-HERE.md's public-task flow — link it instead",
  );
});

test("agent-connect quickstart cites only real invite UI", () => {
  const doc = connectDoc();
  const page = html();
  for (const ui of [
    "Invite agents",
    "Give your agent a place in this room",
    "Create invite",
    "Copy invite link",
  ]) {
    assert.ok(doc.includes(ui), `doc cites "${ui}" but never names it`);
    assert.ok(page.includes(ui), `"${ui}" is cited in the doc but not found in index.html`);
  }
  for (const option of ["Contribute", "Read and chat", "Collaborate", "Review"]) {
    assert.ok(page.includes(option), `invite access option "${option}" is not in index.html`);
    assert.ok(doc.includes(option), `doc never names the "${option}" access option`);
  }
});

test("agent-connect quickstart cites the real join command", () => {
  const doc = connectDoc();
  const help = read("scripts/agent-inbox.mjs");
  assert.ok(
    help.includes("join INVITE_OR_ROOM_URL PRIVATE_DIRECTORY"),
    "the join command usage drifted in scripts/agent-inbox.mjs",
  );
  assert.ok(doc.includes("agent-inbox.mjs join"), "doc never shows the join command");
  const setup = read("client/agent-setup.mjs");
  assert.ok(setup.includes("--accept"), "join --accept handling is gone from client/agent-setup.mjs");
  assert.ok(
    setup.includes("room_check_access"),
    "the join output no longer names room_check_access",
  );
  assert.ok(doc.includes("--accept"), "doc never shows the --accept repeat");
  assert.ok(doc.includes("room_check_access"), "doc never names the room_check_access verification");
});

test("agent-connect quickstart hosted-MCP commands match the product's own snippet", async () => {
  const { roomMcpSnippets } = await import("../src/room-mcp-join.js");
  const snippet = roomMcpSnippets("https://room.trydemigod.com/mcp");
  const doc = connectDoc();
  assert.ok(
    doc.includes(snippet.claude),
    "the Claude hosted-MCP command drifted from roomMcpSnippets()",
  );
  assert.ok(
    doc.includes(snippet.codex),
    "the Codex hosted-MCP command drifted from roomMcpSnippets()",
  );
  assert.ok(doc.includes("https://room.trydemigod.com/mcp"), "hosted MCP URL is missing");
});

test("agent-connect quickstart hosted join path matches the live agent packet", async () => {
  const { llmsFullTxt } = await import("../deploy/agent-discovery.mjs");
  const packet = llmsFullTxt();
  assert.ok(packet.includes("room_join"), "llms-full.txt lost the room_join reference");
  assert.ok(
    packet.includes("Authorization: Bearer"),
    "llms-full.txt lost the hosted-MCP auth header reference",
  );
  const doc = connectDoc();
  assert.ok(doc.includes("room_join"), "doc never names the room_join tool");
  assert.ok(doc.includes("Authorization: Bearer"), "doc never states the hosted-MCP auth header");
});

test("agent-connect quickstart room_join fields match the server schema", async () => {
  const { hostedMcpToolDefs } = await import("../server/mcp-hosted-tools.mjs");
  const joinTool = hostedMcpToolDefs.find((tool) => tool.name === "room_join");
  assert.ok(joinTool, "room_join is missing from the hosted MCP catalog");
  const fields = Object.keys(joinTool.inputSchema.properties ?? {});
  assert.ok(
    fields.includes("linkToken") && fields.includes("inviteCode"),
    `room_join schema fields drifted: ${fields.join(", ")}`,
  );
  const doc = connectDoc();
  for (const field of ["linkToken", "inviteCode"]) {
    assert.ok(doc.includes(field), `doc never shows the room_join "${field}" field`);
  }
});
