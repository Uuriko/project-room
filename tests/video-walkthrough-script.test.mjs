// O011: video walkthrough script — every shot must be a real product screen.
// Contract: every UI element, tool name, command, and route cited in the
// script exists in the checked-in product, and the doc's stated beat
// timings sum to the 3:00–5:00 target window. This catches docs drift when
// UI copy, the invite flow, or the hosted-MCP snippet changes, and catches
// script edits that invent screens. Distinct from quickstarts-docs (O012 /
// O013 docs): those never assert shot-grounding or timing self-consistency.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const page = () => read("index.html");
const boardUi = () => read("src/board-ui.js");
const script = () => read("docs/VIDEO-WALKTHROUGH-SCRIPT.md");

// Beat headings look like: ## Beat 1 — The room (0:15–1:10)
const beats = (doc) =>
  [...doc.matchAll(/^## Beat \d+ — .+?\((\d+):(\d+)[–—-](\d+):(\d+)\)/gm)].map(
    (m) => ({
      start: Number(m[1]) * 60 + Number(m[2]),
      end: Number(m[3]) * 60 + Number(m[4]),
    }),
  );

const assertCitedInDoc = (doc, value) => {
  assert.ok(doc.includes(value), `script cites "${value}" but never names it`);
};

test("walkthrough script exists with hook, room+claims, inbox, connect, close beats", () => {
  assert.ok(
    existsSync(join(ROOT, "docs/VIDEO-WALKTHROUGH-SCRIPT.md")),
    "docs/VIDEO-WALKTHROUGH-SCRIPT.md is missing",
  );
  const doc = script();
  assert.ok(/^## Hook \(/m.test(doc), "no timed Hook beat heading");
  for (const name of ["room", "claims", "inbox", "connect", "close"]) {
    assert.ok(
      new RegExp(`^## .*(?:${name})`, "im").test(doc),
      `no beat heading covering "${name}"`,
    );
  }
});

test("beat timings are contiguous from 0:00 and sum to the 3:00–5:00 window", () => {
  const doc = script();
  const hookMatch = doc.match(/^## Hook \((\d+):(\d+)[–—-](\d+):(\d+)\)/m);
  assert.ok(hookMatch, "hook heading must carry a time range");
  const hookStart = Number(hookMatch[1]) * 60 + Number(hookMatch[2]);
  const hookEnd = Number(hookMatch[3]) * 60 + Number(hookMatch[4]);
  assert.ok(hookEnd <= 15, `hook must end by 0:15, ends at ${hookEnd}s`);
  const timeline = [{ start: hookStart, end: hookEnd }, ...beats(doc)];
  assert.ok(timeline.length >= 6, `expected hook + >=5 beats, got ${timeline.length}`);
  assert.equal(timeline[0].start, 0, "hook must start at 0:00");
  for (let i = 1; i < timeline.length; i++) {
    assert.equal(
      timeline[i].start,
      timeline[i - 1].end,
      `segment ${i + 1} must start where segment ${i} ends`,
    );
  }
  const total = timeline[timeline.length - 1].end;
  assert.ok(
    total >= 180 && total <= 300,
    `script must total 3:00–5:00, totals ${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`,
  );
});

test("room shots cite only real room surface", () => {
  const doc = script();
  const html = page();
  for (const ui of ["Message the room", "Participants", "typing-indicator"]) {
    assertCitedInDoc(doc, ui);
    assert.ok(html.includes(ui), `"${ui}" is cited in the script but not found in index.html`);
  }
  assert.ok(html.includes('id="tasks-board-open"'), "Board button is missing from index.html");
  assertCitedInDoc(doc, "Board");
  assert.ok(html.includes("Invite"), "no Invite control in index.html");
});

test("claims shots cite the real board UI", () => {
  const doc = script();
  const html = page();
  const ui = boardUi();
  assert.ok(html.includes("Tasks › Board"), "Tasks › Board dialog title is missing from index.html");
  assertCitedInDoc(doc, "Tasks › Board");
  for (const column of ["Ready", "Claimed / In progress", "Blocked", "In review", "Landed"]) {
    assert.ok(ui.includes(column), `board column "${column}" is missing from src/board-ui.js`);
  }
  for (const label of ["New item", "Add item"]) {
    assert.ok(ui.includes(label), `board form copy "${label}" is missing from src/board-ui.js`);
    assertCitedInDoc(doc, label);
  }
  for (const action of ["Claim", "Mark in progress", "Link PR", "Done"]) {
    assert.ok(
      ui.includes(`"${action}"`) || ui.includes(`>${action}<`),
      `board action "${action}" is missing from src/board-ui.js`,
    );
    assertCitedInDoc(doc, action);
  }
});

test("inbox shots cite the real inbox UI", () => {
  const doc = script();
  const html = page();
  for (const ui of [
    "Continue with Google",
    "Connect Gmail",
    "imports up to 25 recent inbox messages",
    "Personalize setup",
  ]) {
    assertCitedInDoc(doc, ui);
    assert.ok(html.includes(ui), `"${ui}" is cited in the script but not found in index.html`);
  }
  assert.ok(html.includes('id="nav-inbox"'), "Inbox nav button is missing from index.html");
  assertCitedInDoc(doc, "Inbox");
});

test("connect shots cite the real invite UI", () => {
  const doc = script();
  const html = page();
  for (const ui of [
    "Invite agents",
    "Give your agent a place in this room",
    "Create invite",
    "Copy invite link",
  ]) {
    assertCitedInDoc(doc, ui);
    assert.ok(html.includes(ui), `"${ui}" is cited in the script but not found in index.html`);
  }
  for (const option of ["Contribute", "Read and chat", "Collaborate (owner)", "Review"]) {
    assert.ok(html.includes(option), `invite access option "${option}" is not in index.html`);
    assertCitedInDoc(doc, option);
  }
  const invite = read("src/agent-invite-ui.js");
  assert.ok(invite.includes("single-use and 24h"), "invite-link expiry copy drifted in src/agent-invite-ui.js");
  assertCitedInDoc(doc, "24 hours");
});

test("connect shots cite the real hosted-MCP join path", async () => {
  const { roomMcpSnippets } = await import("../src/room-mcp-join.js");
  const snippet = roomMcpSnippets("https://room.trydemigod.com/mcp");
  const doc = script();
  assert.ok(doc.includes(snippet.claude), "the Claude hosted-MCP command drifted from roomMcpSnippets()");
  assert.ok(doc.includes("https://room.trydemigod.com/mcp"), "hosted MCP URL is missing from the script");
  const { hostedMcpToolDefs } = await import("../server/mcp-hosted-tools.mjs");
  const joinTool = hostedMcpToolDefs.find((tool) => tool.name === "room_join");
  assert.ok(joinTool, "room_join is missing from the hosted MCP catalog");
  const fields = Object.keys(joinTool.inputSchema.properties ?? {});
  assert.ok(
    fields.includes("linkToken") && fields.includes("inviteCode"),
    `room_join schema fields drifted: ${fields.join(", ")}`,
  );
  for (const name of ["room_join", "room_check_access", "linkToken"]) {
    assertCitedInDoc(doc, name);
  }
});

test("script keeps this lane's scope: no money, bounty, or token content", () => {
  const doc = script();
  for (const banned of ["$DASHA", "bounty", "Moltbook"]) {
    assert.ok(
      !doc.toLowerCase().includes(banned.toLowerCase()),
      `script must not advertise "${banned}" — out of this lane's scope`,
    );
  }
});

test("script is registered in the docs index", () => {
  const index = read("docs/INDEX.md");
  assert.ok(
    index.includes("VIDEO-WALKTHROUGH-SCRIPT.md"),
    "docs/INDEX.md does not list the walkthrough script",
  );
});
