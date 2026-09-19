// RC-2026-09-18-039: the join onboarding docs must never drift from the CLI.
// Extracts `node scripts/agent-inbox.mjs <verb>` invocations from the fenced
// code blocks in docs/join/team.md and asserts every verb is a real verb in
// scripts/agent-inbox.mjs (parsed from its argument dispatch), so a renamed
// or removed CLI verb breaks the test instead of silently rotting the docs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEAM_MD = join(root, "docs", "join", "team.md");
const JOIN_MD = join(root, "docs", "join.md");
const CLI = join(root, "scripts", "agent-inbox.mjs");

// Triple-backtick code blocks, whatever info string they carry.
function fencedBlocks(markdown) {
  const blocks = [];
  const re = /```[a-z]*\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(markdown)) !== null) blocks.push(match[1]);
  return blocks;
}

// Verbs the doc tells an agent to run: `node scripts/agent-inbox.mjs <verb>`.
function docVerbs(teamMd) {
  const verbs = new Set();
  for (const block of fencedBlocks(teamMd)) {
    const re = /node scripts\/agent-inbox\.mjs ([a-z0-9][a-z0-9-]*)/g;
    let match;
    while ((match = re.exec(block)) !== null) verbs.add(match[1]);
  }
  return [...verbs].sort();
}

// Real verbs in the CLI, read from its actual argument dispatch:
// top-level specials like reply/watch/doctor/bootstrap-agent-room/account-link
// route through `action === "verb"`; connect/import/check and friends route
// through `["connect", "import", "check"].includes(action)` verb lists.
function cliVerbs(cliSource) {
  const verbs = new Set();
  let match;
  const single = /action === "([a-z0-9][a-z0-9-]*)"/g;
  while ((match = single.exec(cliSource)) !== null) verbs.add(match[1]);
  const list = /\["([a-z0-9-]+"(?: *, *"[a-z0-9-]+")*)\]\.includes\(action\)/g;
  while ((match = list.exec(cliSource)) !== null) {
    for (const token of match[1].split(/ *, */)) verbs.add(token.replaceAll('"', ""));
  }
  return verbs;
}

test("join/team.md code fences invoke only real agent-inbox.mjs verbs", () => {
  const teamMd = readFileSync(TEAM_MD, "utf8");
  const verbs = docVerbs(teamMd);
  assert.ok(verbs.length > 0, "team.md should contain agent-inbox.mjs invocations to guard");
  const real = cliVerbs(readFileSync(CLI, "utf8"));
  assert.ok(real.size > 0, "could not parse any verbs from scripts/agent-inbox.mjs");
  const unknown = verbs.filter(verb => !real.has(verb));
  assert.deepEqual(unknown, [],
    `docs/join/team.md uses CLI verbs that do not exist: ${unknown.join(", ")}. ` +
    `Doc verbs: ${verbs.join(", ")}`);
});

test("join/team.md walks all seven enrollment steps", () => {
  const teamMd = readFileSync(TEAM_MD, "utf8");
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    assert.ok(teamMd.includes(`## ${n}.`), `team.md should have step heading ## ${n}.`);
  }
});

test("join.md carries one copyable prompt that sends the agent to team.md", () => {
  const joinMd = readFileSync(JOIN_MD, "utf8");
  assert.ok(fencedBlocks(joinMd).length >= 1, "join.md should contain a copyable fenced prompt");
  assert.ok(joinMd.includes("docs/join/team.md"),
    "join.md's prompt must point the agent at docs/join/team.md");
});
